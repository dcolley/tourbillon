import { Worker, type Job } from 'bullmq';
import { createConnection } from './redis';

const workerConnection = createConnection();
import { db, agents, heartbeatRuns, companies, costEvents, issues, getLlmProviderRowById } from '@tourbillon/db';
import { eq, and, sql } from 'drizzle-orm';
import {
  createDurableAgentWithSkills,
  createHeartbeatRuntimeContext,
  flushObservability,
  getInternalApiUrl,
  buildHeartbeatMemoryKeys,
  getResumableDurableRun,
  persistDurableRunId,
  resolveAgentModelSettings,
  shouldUseHeartbeatMemory,
  clearInboxThread,
} from '@tourbillon/mastra';
import type { HeartbeatJobData } from '@tourbillon/shared';
import type { AgentModelSettings } from '@tourbillon/shared';
import {
  DEFAULT_HEARTBEAT_TIMEOUT_SEC,
  QUEUE_HEARTBEAT,
  resolveModelProviderConfig,
  modelProviderOverridesFromAgent,
  toLlmProviderRecord,
  isAgentBudgetExceeded,
  isObservabilityEnabled,
  isHarnessAdapter,
  buildWakeMessage,
  parseCompanySettings,
} from '@tourbillon/shared';
import type { AgentRuntimeConfig } from '@tourbillon/shared';
import type { Agent as AgentRecord } from '@tourbillon/db';
import { randomUUID } from 'crypto';
import { createJobTracer } from './job-trace';
import { runWithHarness, type HarnessRunResult } from './adapters/harness-adapter';
import { redisPub } from './redis-pub';

const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY ?? '1', 10);

export const heartbeatWorker = new Worker<HeartbeatJobData>(
  QUEUE_HEARTBEAT,
  processHeartbeat,
  { connection: workerConnection, concurrency: CONCURRENCY, stalledInterval: 30_000 }
);

heartbeatWorker.on('completed', (job) => {
  const tracer = createJobTracer('heartbeat', {
    jobId: job.id,
    agentId: job.data.agentId,
    taskId: job.data.taskId,
    wakeReason: job.data.wakeReason,
  });
  tracer.info('job completed');
});

heartbeatWorker.on('failed', (job, err) => {
  const tracer = createJobTracer('heartbeat', {
    jobId: job?.id,
    agentId: job?.data.agentId,
    taskId: job?.data.taskId,
    wakeReason: job?.data.wakeReason,
  });
  tracer.error('job failed', { error: err.message });
});

interface TokenUsageResult {
  inputTokens: number;
  outputTokens: number;
  traceId?: string;
}

async function publishHeartbeatRunUpdate(
  companyId: string,
  runId: string,
  status: 'succeeded' | 'failed',
  agentId: string,
): Promise<void> {
  await redisPub.publish(
    `sse:${companyId}`,
    JSON.stringify({ type: 'heartbeat_run_update', runId, status, agentId }),
  );
}

async function recordHeartbeatSuccess(
  runId: string,
  agentRecord: AgentRecord,
  companyId: string,
  provider: string,
  usage: TokenUsageResult,
): Promise<void> {
  const total = usage.inputTokens + usage.outputTokens;
  if (total > 0) {
    await db.insert(costEvents).values({
      agentId: agentRecord.id,
      companyId,
      runId,
      provider,
      model: agentRecord.modelId ?? 'unknown',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costCents: 0,
    });
    await db.update(agents)
      .set({ spentMonthlyTokens: sql`${agents.spentMonthlyTokens} + ${total}` })
      .where(eq(agents.id, agentRecord.id));
  }

  const runUpdates: { status: 'succeeded'; finishedAt: Date; traceId?: string } = {
    status: 'succeeded',
    finishedAt: new Date(),
  };
  if (usage.traceId) {
    runUpdates.traceId = usage.traceId;
  }

  await db.update(heartbeatRuns).set(runUpdates).where(eq(heartbeatRuns.id, runId));

  await publishHeartbeatRunUpdate(companyId, runId, 'succeeded', agentRecord.id);

  if (isObservabilityEnabled()) {
    await flushObservability();
  }
}

async function recordHeartbeatFailure(
  runId: string,
  errorText: string,
  companyId: string,
  agentId: string,
): Promise<void> {
  if (isObservabilityEnabled()) {
    await flushObservability().catch(() => undefined);
  }

  await db.update(heartbeatRuns)
    .set({ status: 'failed', finishedAt: new Date(), errorText })
    .where(eq(heartbeatRuns.id, runId));

  await publishHeartbeatRunUpdate(companyId, runId, 'failed', agentId);
}

async function processHeartbeat(job: Job<HeartbeatJobData>): Promise<void> {
  const { agentId, companyId, invocationSource, wakeReason, taskId } = job.data;
  const tracer = createJobTracer(
    'heartbeat',
    {
      jobId: job.id,
      agentId,
      companyId,
      taskId,
      wakeReason,
    },
    job
  );

  tracer.info('processing heartbeat job', {
    invocationSource,
    apiBase: getInternalApiUrl(),
    jobData: job.data,
  });

  const agentRecord = await db.query.agents.findFirst({
    where: and(eq(agents.id, agentId), eq(agents.companyId, companyId)),
  });
  if (!agentRecord) throw new Error(`Agent ${agentId} not found`);

  const agentTracer = tracer.child({ agentName: agentRecord.name });

  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  if (!company) throw new Error(`Company ${companyId} not found`);

  if (agentRecord.status !== 'active') {
    agentTracer.warn('skipped: agent not active', { status: agentRecord.status });
    return;
  }
  if (company.status !== 'active') {
    agentTracer.warn('skipped: company not active', { status: company.status });
    return;
  }
  if (
    isAgentBudgetExceeded(
      agentRecord.spentMonthlyTokens,
      agentRecord.budgetMonthlyTokens,
      agentRecord.runtimeConfig as AgentRuntimeConfig,
    )
  ) {
    agentTracer.warn('skipped: over token budget', {
      spentMonthlyTokens: agentRecord.spentMonthlyTokens,
      budgetMonthlyTokens: agentRecord.budgetMonthlyTokens,
      enforceBudget: (agentRecord.runtimeConfig as AgentRuntimeConfig).budget?.enforce !== false,
    });
    return;
  }

  let assignedIssue: Awaited<ReturnType<typeof db.query.issues.findFirst>> | undefined;
  if (taskId) {
    assignedIssue = await db.query.issues.findFirst({ where: eq(issues.id, taskId) });
    agentTracer.info('assignment wake target issue', {
      taskId,
      found: Boolean(assignedIssue),
      identifier: assignedIssue?.identifier,
      title: assignedIssue?.title,
      status: assignedIssue?.status,
      assigneeAgentId: assignedIssue?.assigneeAgentId,
      assigneeMatchesAgent: assignedIssue?.assigneeAgentId === agentId,
      checkoutRunId: assignedIssue?.checkoutRunId,
    });
  }

  const runId = randomUUID();
  const runTracer = agentTracer.child({ runId, taskId });

  await db.insert(heartbeatRuns).values({
    id: runId,
    agentId,
    companyId,
    invocationSource,
    status: 'running',
    contextSnapshot: {
      wakeReason,
      wakePayloadJson: job.data.wakePayloadJson,
      taskId: job.data.taskId,
      jobId: job.id,
      agentName: agentRecord.name,
      agentUrlKey: agentRecord.urlKey,
    },
    startedAt: new Date(),
  });
  runTracer.info('heartbeat run created');

  if (assignedIssue && assignedIssue.assigneeAgentId !== agentId) {
    const errorText = `Task ${taskId} is assigned to agent ${assignedIssue.assigneeAgentId}, not ${agentId}`;
    runTracer.warn('skipped: assignee mismatch', {
      taskId,
      expectedAgentId: agentId,
      actualAssigneeAgentId: assignedIssue.assigneeAgentId,
    });
    await recordHeartbeatFailure(runId, errorText, companyId, agentId);
    return;
  }

  const apiKey = buildRunScopedApiKey(runId, agentId, companyId);
  const wakeMessage = buildWakeMessage(job.data);
  const timeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_SEC * 1000;

  const providerRow = agentRecord.providerId
    ? await getLlmProviderRowById(agentRecord.providerId)
    : null;
  const providerRecord = providerRow ? toLlmProviderRecord(providerRow) : null;
  const providerConfig = resolveModelProviderConfig(
    modelProviderOverridesFromAgent(agentRecord.adapterType, agentRecord.adapterConfig),
    agentRecord.modelId,
    providerRecord,
  );

  const issueForTask = taskId
    ? await db.query.issues.findFirst({ where: eq(issues.id, taskId) })
    : undefined;

  const modelSettings = resolveAgentModelSettings(agentRecord, providerRecord);

  runTracer.info('invoking heartbeat runtime', {
    adapterType: agentRecord.adapterType,
    modelId: agentRecord.modelId ?? 'unknown',
    provider: providerConfig.provider,
    providerId: providerConfig.providerId,
    providerName: providerConfig.providerName,
    apiMode: providerConfig.apiMode,
    modelBaseURL: providerConfig.baseURL,
    modelSettings,
    timeoutSec: DEFAULT_HEARTBEAT_TIMEOUT_SEC,
    wakeMessagePreview: wakeMessage.slice(0, 400),
  });

  const lockExtender = setInterval(() => {
    void job.extendLock(job.token!, 30_000).catch(() => undefined);
  }, 20_000);

  try {
    if (isHarnessAdapter(agentRecord.adapterType)) {
      const harnessResult = await runWithHarness(
        agentRecord,
        {
          job,
          runId,
          apiKey,
          goalId: issueForTask?.goalId ?? undefined,
          projectId: issueForTask?.projectId ?? undefined,
        },
        timeoutMs,
        {
          allowedMcpServerIds: company.allowedMcpServerIds ?? [],
          companySettings: parseCompanySettings(company.settings),
        },
      );

      await logIssueStateAfterRun(runTracer, taskId);
      await recordHarnessResult(
        runId,
        agentRecord,
        companyId,
        providerConfig.provider,
        harnessResult,
      );
      runTracer.info('harness heartbeat succeeded', {
        finishReason: harnessResult.finishReason,
        traceId: harnessResult.traceId,
      });
      return;
    }

    await runDurableAgentHeartbeat({
      agentRecord,
      job,
      runId,
      runTracer,
      apiKey,
      wakeMessage,
      timeoutMs,
      taskId,
      issueForTask,
      providerConfig,
      companyId,
      modelSettings,
    });
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    runTracer.error('heartbeat run failed', { error: errorText });
    await recordHeartbeatFailure(runId, errorText, companyId, agentId);
    throw err;
  } finally {
    clearInterval(lockExtender);
  }
}

async function recordHarnessResult(
  runId: string,
  agentRecord: AgentRecord,
  companyId: string,
  provider: string,
  result: HarnessRunResult,
): Promise<void> {
  if (result.finishReason === 'suspended') {
    await db.update(heartbeatRuns)
      .set({
        status: 'succeeded',
        finishedAt: new Date(),
        traceId: result.traceId ?? undefined,
        harnessRunId: result.harnessRunId ?? undefined,
      })
      .where(eq(heartbeatRuns.id, runId));

    if (isObservabilityEnabled()) {
      await flushObservability();
    }
    return;
  }

  if (result.finishReason === 'timeout') {
    await recordHeartbeatFailure(runId, 'Heartbeat timeout', companyId, agentRecord.id);
    return;
  }

  if (result.finishReason === 'error') {
    await recordHeartbeatFailure(runId, 'Harness run failed', companyId, agentRecord.id);
    return;
  }

  await recordHeartbeatSuccess(runId, agentRecord, companyId, provider, {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    traceId: result.traceId,
  });
}

async function runDurableAgentHeartbeat(params: {
  agentRecord: AgentRecord;
  job: Job<HeartbeatJobData>;
  runId: string;
  runTracer: ReturnType<typeof createJobTracer>;
  apiKey: string;
  wakeMessage: string;
  timeoutMs: number;
  taskId?: string;
  issueForTask: Awaited<ReturnType<typeof db.query.issues.findFirst>> | undefined;
  providerConfig: ReturnType<typeof resolveModelProviderConfig>;
  companyId: string;
  modelSettings?: AgentModelSettings;
}): Promise<void> {
  const {
    agentRecord,
    job,
    runId,
    runTracer,
    apiKey,
    wakeMessage,
    timeoutMs,
    taskId,
    issueForTask,
    providerConfig,
    companyId,
    modelSettings,
  } = params;

  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  const durableAgent = await createDurableAgentWithSkills(agentRecord, {
    allowedMcpServerIds: company?.allowedMcpServerIds ?? [],
    companySettings: parseCompanySettings(company?.settings),
    maxSteps: 30,
  });

  const runtimeContext = createHeartbeatRuntimeContext({
    apiKey,
    runId,
    agentId: agentRecord.id,
    companyId,
    taskId,
    goalId: issueForTask?.goalId ?? undefined,
    projectId: issueForTask?.projectId ?? undefined,
    jobId: job.id ?? undefined,
  });

  const memoryKeys = buildHeartbeatMemoryKeys({
    companyId,
    agentId: agentRecord.id,
    issueId: taskId,
    goalId: issueForTask?.goalId ?? undefined,
    projectId: issueForTask?.projectId ?? undefined,
  });

  const resumable = await getResumableDurableRun(agentRecord.id, taskId);
  const useMemory = shouldUseHeartbeatMemory(taskId);

  if (!resumable && !useMemory) {
    await clearInboxThread(companyId, agentRecord.id);
    runTracer.info('cleared inbox thread for stateless wake');
  }

  runTracer.info('heartbeat memory', {
    useMemory,
    thread: useMemory ? memoryKeys.thread : undefined,
  });

  const tracingOptions = isObservabilityEnabled()
    ? {
        metadata: {
          issueId: taskId,
          goalId: issueForTask?.goalId ?? undefined,
          projectId: issueForTask?.projectId ?? undefined,
          heartbeatRunId: runId,
          jobId: job.id,
          companyId,
          agentId: agentRecord.id,
        },
        tags: taskId ? [`issue:${taskId}`] : [],
        requestContextKeys: [
          'runId',
          'agentId',
          'companyId',
          'taskId',
          'goalId',
          'projectId',
          'jobId',
        ],
      }
    : undefined;

  const keepalive = setInterval(() => {
    void job.updateProgress(0).catch(() => undefined);
  }, 20_000);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let inputTokens = 0;
    let outputTokens = 0;
    let traceId: string | undefined;
    let durableRunId: string | undefined;
    let streamResult: { cleanup: () => void } | undefined;

    try {
      if (resumable?.durableRunId) {
        runTracer.info('resuming durable agent run', { durableRunId: resumable.durableRunId });
        const observed = await durableAgent.observe(resumable.durableRunId, {
          offset: 0,
          abortSignal: controller.signal,
          onFinish: (result) => {
            const usage = result.output?.usage;
            inputTokens = usage?.promptTokens ?? usage?.inputTokens ?? inputTokens;
            outputTokens = usage?.completionTokens ?? usage?.outputTokens ?? outputTokens;
          },
        } as NonNullable<Parameters<typeof durableAgent.observe>[1]> & { abortSignal: AbortSignal });
        streamResult = observed;
        durableRunId = observed.runId;
        traceId = observed.runId;
        await observed.output.text;
        observed.cleanup();
        streamResult = undefined;
      } else {
        const streamed = await durableAgent.stream(wakeMessage, {
          requestContext: runtimeContext,
          maxSteps: 30,
          ...(useMemory
            ? {
                memory: {
                  resource: memoryKeys.resource,
                  thread: memoryKeys.thread,
                },
              }
            : {}),
          ...(modelSettings ? { modelSettings } : {}),
          ...(tracingOptions ? { tracingOptions } : {}),
          abortSignal: controller.signal,
          onFinish: (result) => {
            const usage = result.output?.usage;
            inputTokens = usage?.promptTokens ?? usage?.inputTokens ?? 0;
            outputTokens = usage?.completionTokens ?? usage?.outputTokens ?? 0;
          },
        } as NonNullable<Parameters<typeof durableAgent.stream>[1]> & { abortSignal: AbortSignal });
        streamResult = streamed;
        durableRunId = streamed.runId;
        traceId = streamed.runId;
        await streamed.output.text;
        streamed.cleanup();
        streamResult = undefined;
      }
    } catch (err) {
      streamResult?.cleanup();
      if (controller.signal.aborted) {
        throw new Error('Heartbeat timeout');
      }
      throw err;
    }

    if (durableRunId) {
      await persistDurableRunId(runId, durableRunId);
    }

    await logIssueStateAfterRun(runTracer, taskId);

    await recordHeartbeatSuccess(runId, agentRecord, companyId, providerConfig.provider, {
      inputTokens,
      outputTokens,
      traceId,
    });

    runTracer.info('durable agent heartbeat succeeded', { traceId, durableRunId });
  } finally {
    clearTimeout(timeout);
    clearInterval(keepalive);
  }
}

async function logIssueStateAfterRun(
  runTracer: ReturnType<typeof createJobTracer>,
  taskId?: string,
): Promise<void> {
  if (!taskId) return;
  const issueAfter = await db.query.issues.findFirst({ where: eq(issues.id, taskId) });
  runTracer.info('issue state after heartbeat', {
    taskId,
    found: Boolean(issueAfter),
    status: issueAfter?.status,
    checkoutRunId: issueAfter?.checkoutRunId,
    updatedAt: issueAfter?.updatedAt?.toISOString(),
  });
}

function buildRunScopedApiKey(runId: string, agentId: string, companyId: string): string {
  const payload = JSON.stringify({ runId, agentId, companyId, iat: Date.now() });
  return `pm_run_${Buffer.from(payload).toString('base64url')}`;
}
