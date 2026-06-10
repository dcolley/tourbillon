import { Worker, type Job } from 'bullmq';
import { createConnection } from './redis';

const workerConnection = createConnection();
import { db, agents, heartbeatRuns, companies, costEvents, issues } from '@tourbillon/db';
import { eq, and, sql } from 'drizzle-orm';
import { createAgentWithSkills, createHeartbeatRuntimeContext, getInternalApiUrl, buildHeartbeatMemoryKeys } from '@tourbillon/mastra';
import type { HeartbeatJobData, WakePayload } from '@tourbillon/shared';
import { DEFAULT_HEARTBEAT_TIMEOUT_SEC, QUEUE_HEARTBEAT, summarizeGenerateResult, resolveModelProviderConfig, modelProviderOverridesFromAgent, isAgentBudgetExceeded } from '@tourbillon/shared';
import type { AgentRuntimeConfig } from '@tourbillon/shared';
import { randomUUID } from 'crypto';
import { createJobTracer } from './job-trace';

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
    await db.update(heartbeatRuns)
      .set({ status: 'failed', finishedAt: new Date(), errorText })
      .where(eq(heartbeatRuns.id, runId));
    return;
  }

  const apiKey = buildRunScopedApiKey(runId, agentId, companyId);
  const agent = await createAgentWithSkills(agentRecord);
  const wakeMessage = buildWakeMessage(job.data);
  const timeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_SEC * 1000;

  const providerConfig = resolveModelProviderConfig(
    modelProviderOverridesFromAgent(agentRecord.adapterType, agentRecord.adapterConfig),
    agentRecord.modelId,
  );

  runTracer.info('invoking agent.generate', {
    modelId: agentRecord.modelId ?? 'unknown',
    provider: providerConfig.provider,
    apiMode: providerConfig.apiMode,
    modelBaseURL: providerConfig.baseURL,
    timeoutSec: DEFAULT_HEARTBEAT_TIMEOUT_SEC,
    wakeMessagePreview: wakeMessage.slice(0, 400),
    runtimeContextKeys: ['apiKey', 'runId', 'agentId', 'companyId', 'taskId'],
  });

  const runtimeContext = createHeartbeatRuntimeContext({
    apiKey,
    runId,
    agentId,
    companyId,
    taskId,
  });

  let memoryKeys = buildHeartbeatMemoryKeys({ companyId, agentId, issueId: taskId });
  if (taskId) {
    const issueForMemory = await db.query.issues.findFirst({ where: eq(issues.id, taskId) });
    if (issueForMemory) {
      memoryKeys = buildHeartbeatMemoryKeys({
        companyId,
        agentId,
        issueId: taskId,
        goalId: issueForMemory.goalId,
        projectId: issueForMemory.projectId,
      });
    }
  }

  // runTracer.info('memory keys resolved', { ...memoryKeys });

  try {
    const result = await Promise.race([
      agent.generate(wakeMessage, {
        requestContext: runtimeContext,
        maxSteps: 30,
        memory: {
          resource: memoryKeys.resource,
          thread: memoryKeys.thread,
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Heartbeat timeout')), timeoutMs)
      ),
    ]);

    // const summary = summarizeGenerateResult(result);
    // runTracer.info('agent.generate finished', summary);

    if (taskId) {
      const issueAfter = await db.query.issues.findFirst({ where: eq(issues.id, taskId) });
      runTracer.info('issue state after heartbeat', {
        taskId,
        found: Boolean(issueAfter),
        status: issueAfter?.status,
        checkoutRunId: issueAfter?.checkoutRunId,
        checkoutMatchesRun: issueAfter?.checkoutRunId === runId,
        updatedAt: issueAfter?.updatedAt?.toISOString(),
      });
    }

    if (result.usage) {
      const inputTokens = result.usage.inputTokens ?? result.usage.promptTokens ?? 0;
      const outputTokens = result.usage.outputTokens ?? result.usage.completionTokens ?? 0;
      const total = inputTokens + outputTokens;
      await db.insert(costEvents).values({
        agentId,
        companyId,
        runId,
        provider: providerConfig.provider,
        model: agentRecord.modelId ?? 'unknown',
        inputTokens,
        outputTokens,
        costCents: 0,
      });
      await db.update(agents)
        .set({ spentMonthlyTokens: sql`${agents.spentMonthlyTokens} + ${total}` })
        .where(eq(agents.id, agentId));
      runTracer.info('token usage recorded', { totalTokens: total });
    }

    await db.update(heartbeatRuns)
      .set({ status: 'succeeded', finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));
    runTracer.info('heartbeat run succeeded');
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    runTracer.error('heartbeat run failed', { error: errorText });
    await db.update(heartbeatRuns)
      .set({ status: 'failed', finishedAt: new Date(), errorText })
      .where(eq(heartbeatRuns.id, runId));
    throw err;
  }
}

const WAKE_COMMENTS_MAX_CHARS = 3000;

function buildWakeMessage(data: HeartbeatJobData): string {
  const parts = [`Wake reason: ${data.wakeReason}`];
  if (data.taskId) parts.push(`Assigned task ID: ${data.taskId}`);
  if (data.wakePayloadJson) {
    try {
      const payload = JSON.parse(data.wakePayloadJson) as WakePayload;
      if (payload.issue) {
        parts.push(
          `Task: ${payload.issue.identifier} — ${payload.issue.title} (${payload.issue.status}, ${payload.issue.priority})`
        );
      }
      if (payload.newComments?.length) {
        const commentLines: string[] = ['\nRecent issue comments:'];
        let chars = 0;
        for (const c of payload.newComments) {
          const line = `- [${c.createdAt}] ${c.authorName}: ${c.body}`;
          if (chars + line.length > WAKE_COMMENTS_MAX_CHARS) {
            commentLines.push('- … (truncated)');
            break;
          }
          commentLines.push(line);
          chars += line.length;
        }
        parts.push(commentLines.join('\n'));
      }
      if (payload.fallbackFetchNeeded) {
        parts.push(
          '\nFull comment history may be incomplete in this wake message. ' +
            'After checkout, call getComments without `after` for the full thread.'
        );
      }
    } catch { /* ignore */ }
  }
  parts.push('\nBegin your heartbeat procedure. Follow SKILL: Control Plane Operations exactly.');
  return parts.join('\n');
}

function buildRunScopedApiKey(runId: string, agentId: string, companyId: string): string {
  const payload = JSON.stringify({ runId, agentId, companyId, iat: Date.now() });
  return `pm_run_${Buffer.from(payload).toString('base64url')}`;
}
