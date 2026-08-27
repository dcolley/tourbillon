import { db, agents, heartbeatRuns, companies, costEvents, issues, activityLog, getLlmProviderRowById } from '@tourbillon/db';
import { eq, and, sql, lt } from 'drizzle-orm';
import {
  createDurableAgentWithSkills,
  createHeartbeatRuntimeContext,
  flushObservability,
  getInternalApiUrl,
  buildHeartbeatMemoryKeys,
  getResumableDurableRun,
  persistDurableRunId,
  resolveAgentGenerationOptions,
  toMastraCallOptions,
  type AgentGenerationOptions,
  shouldUseHeartbeatMemory,
  clearInboxThread,
  buildHeartbeatTracingOptions,
} from '@tourbillon/mastra';
import type { HeartbeatJobData, AgentRuntimeConfig } from '@tourbillon/shared';
import {
  heartbeatStaleErrorText,
  resolveHeartbeatLivenessConfig,
  resolveModelProviderConfig,
  modelProviderOverridesFromAgent,
  toLlmProviderRecord,
  isAgentBudgetExceeded,
  isMastraTracingEnabled,
  isHarnessAdapter,
  buildWakeMessage,
  parseCompanySettings,
  createTraceLogger,
} from '@tourbillon/shared';
import { durableWakeOutcomeFromTripwire } from './durable-wake-outcome';
import type { Agent as AgentRecord } from '@tourbillon/db';
import { randomUUID } from 'crypto';
import { runWithHarness, type HarnessRunResult } from './adapters/harness-adapter';
import { redisPub } from './redis-pub';
import {
  awaitWithAbort,
  heartbeatAbortedError,
  isAbortLikeError,
  resolveHeartbeatFailureError,
} from './heartbeat-abort';
import {
  findIssueToPark,
  hasMaterialWork,
  shouldParkIssue,
} from './park-helpers';

export type WakeRequest = HeartbeatJobData;

export interface WakeResult {
  runId: string;
  status: 'succeeded' | 'failed' | 'skipped';
  errorText?: string;
}

type WakeTracer = ReturnType<typeof createTraceLogger>;

/** In-process single-flight + follow-up queue per agent (replaces BullMQ dedupe). */
const agentLocks = new Map<string, Promise<void>>();
const agentFollowUps = new Map<string, WakeRequest[]>();

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

  const runUpdates: { status: 'succeeded'; finishedAt: Date; errorText: null; traceId?: string } = {
    status: 'succeeded',
    finishedAt: new Date(),
    errorText: null,
  };
  if (usage.traceId) {
    runUpdates.traceId = usage.traceId;
  }

  await db.update(heartbeatRuns).set(runUpdates).where(eq(heartbeatRuns.id, runId));
  await publishHeartbeatRunUpdate(companyId, runId, 'succeeded', agentRecord.id);

  if (isMastraTracingEnabled()) {
    await flushObservability();
  }
}

async function recordHeartbeatFailure(
  runId: string,
  errorText: string,
  companyId: string,
  agentId: string,
): Promise<void> {
  if (isMastraTracingEnabled()) {
    await flushObservability().catch(() => undefined);
  }

  await db.update(heartbeatRuns)
    .set({ status: 'failed', finishedAt: new Date(), errorText })
    .where(eq(heartbeatRuns.id, runId));

  await publishHeartbeatRunUpdate(companyId, runId, 'failed', agentId);
}

/**
 * Trigger an agent wake. Coalesces concurrent wakes per agent: if a run is active,
 * queues at most one follow-up (latest wins for assignment/timer).
 */
export async function triggerWake(wake: WakeRequest): Promise<WakeResult> {
  const started = await startWake(wake);
  if (started.status !== 'started') {
    return {
      runId: started.runId,
      status: 'skipped',
      errorText: started.errorText,
    };
  }
  return started.done;
}

export interface StartWakeResult {
  runId: string;
  status: 'started' | 'queued' | 'skipped';
  errorText?: string;
  /** Resolves when the wake fully finishes. */
  done: Promise<WakeResult>;
}

/**
 * Create heartbeat_runs promptly, then run LLM work in the background so HTTP
 * can redirect to `/heartbeat/{runId}` immediately.
 */
export async function startWake(wake: WakeRequest): Promise<StartWakeResult> {
  const lock = agentLocks.get(wake.agentId);
  if (lock) {
    agentFollowUps.set(wake.agentId, [wake]);
    createTraceLogger('wake', {
      agentId: wake.agentId,
      companyId: wake.companyId,
      wakeReason: wake.wakeReason,
    }).info('wake queued behind in-flight run');
    return {
      runId: '',
      status: 'queued',
      errorText: 'coalesced behind in-flight wake',
      done: Promise.resolve({
        runId: '',
        status: 'skipped',
        errorText: 'coalesced behind in-flight wake',
      }),
    };
  }

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  agentLocks.set(wake.agentId, gate);

  let resolveRunId!: (runId: string) => void;
  const runIdReady = new Promise<string>((resolve) => {
    resolveRunId = resolve;
  });

  const done = runWake(wake, { onRunCreated: resolveRunId })
    .catch((err) => {
      const errorText = err instanceof Error ? err.message : String(err);
      resolveRunId('');
      return { runId: '', status: 'failed' as const, errorText };
    })
    .finally(() => {
      agentLocks.delete(wake.agentId);
      release();
      const next = agentFollowUps.get(wake.agentId);
      agentFollowUps.delete(wake.agentId);
      if (next?.[0]) {
        void startWake(next[0]).catch((err) => {
          createTraceLogger('wake', { agentId: wake.agentId }).error('follow-up wake failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    });

  const runId = await Promise.race([
    runIdReady,
    done.then((r) => r.runId),
  ]);

  if (!runId) {
    const result = await done;
    return {
      runId: '',
      status: 'skipped',
      errorText: result.errorText ?? 'wake skipped',
      done,
    };
  }

  return { runId, status: 'started', done };
}

async function runWake(
  wake: WakeRequest,
  opts: { onRunCreated?: (runId: string) => void } = {},
): Promise<WakeResult> {
  const { agentId, companyId, invocationSource, wakeReason, taskId } = wake;
  const tracer = createTraceLogger('wake', {
    agentId,
    companyId,
    taskId,
    wakeReason,
  });

  tracer.info('processing wake', {
    invocationSource,
    apiBase: getInternalApiUrl(),
    wake,
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
    opts.onRunCreated?.('');
    return { runId: '', status: 'skipped', errorText: `agent status ${agentRecord.status}` };
  }
  if (company.status !== 'active') {
    agentTracer.warn('skipped: company not active', { status: company.status });
    opts.onRunCreated?.('');
    return { runId: '', status: 'skipped', errorText: `company status ${company.status}` };
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
    });
    opts.onRunCreated?.('');
    return { runId: '', status: 'skipped', errorText: 'over token budget' };
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
    });
  }

  const runId = randomUUID();
  const runTracer = agentTracer.child({ runId, taskId });
  const runStartedAt = new Date();

  const providerRow = agentRecord.providerId
    ? await getLlmProviderRowById(agentRecord.providerId)
    : null;
  const providerRecord = providerRow ? toLlmProviderRecord(providerRow) : null;
  const providerConfig = resolveModelProviderConfig(
    modelProviderOverridesFromAgent(agentRecord.adapterType, agentRecord.adapterConfig),
    agentRecord.modelId,
    providerRecord,
  );

  await db.insert(heartbeatRuns).values({
    id: runId,
    agentId,
    companyId,
    invocationSource,
    status: 'running',
    contextSnapshot: {
      wakeReason,
      wakePayloadJson: wake.wakePayloadJson,
      taskId: wake.taskId,
      agentName: agentRecord.name,
      agentUrlKey: agentRecord.urlKey,
      approvalId: wake.approvalId,
      approvalStatus: wake.approvalStatus,
      approvalNote: wake.approvalNote,
      linkedIssueIds: wake.linkedIssueIds,
      providerId: agentRecord.providerId ?? null,
      providerName: providerRow?.name ?? providerConfig.providerName ?? providerConfig.provider,
      modelId: agentRecord.modelId ?? null,
    },
    startedAt: runStartedAt,
    lastSeenAt: runStartedAt,
  });
  runTracer.info('heartbeat run created');
  opts.onRunCreated?.(runId);

  if (assignedIssue && assignedIssue.assigneeAgentId !== agentId) {
    const errorText = `Task ${taskId} is assigned to agent ${assignedIssue.assigneeAgentId}, not ${agentId}`;
    runTracer.warn('skipped: assignee mismatch', {
      taskId,
      expectedAgentId: agentId,
      actualAssigneeAgentId: assignedIssue.assigneeAgentId,
    });
    await recordHeartbeatFailure(runId, errorText, companyId, agentId);
    return { runId, status: 'failed', errorText };
  }

  const apiKey = buildRunScopedApiKey(runId, agentId, companyId);
  const wakeMessage = buildWakeMessage(wake);
  const liveness = resolveHeartbeatLivenessConfig();
  const staleMs = liveness.staleSec * 1000;
  const runStartedMs = Date.now();
  const abortController = new AbortController();

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const resetWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => abortController.abort(), staleMs);
  };
  resetWatchdog();

  const pingHeartbeat = () => {
    if (abortController.signal.aborted) return;
    resetWatchdog();
    void db.update(heartbeatRuns)
      .set({ lastSeenAt: new Date() })
      .where(eq(heartbeatRuns.id, runId))
      .catch(() => undefined);
  };

  abortController.signal.addEventListener(
    'abort',
    () => {
      runTracer.warn('wake abort signal fired');
    },
    { once: true },
  );

  pingHeartbeat();
  const pingInterval = setInterval(pingHeartbeat, liveness.pingIntervalMs);

  const issueForTask = taskId
    ? await db.query.issues.findFirst({ where: eq(issues.id, taskId) })
    : undefined;

  const generationOptions = resolveAgentGenerationOptions(agentRecord, providerRecord);

  runTracer.info('invoking wake runtime', {
    adapterType: agentRecord.adapterType,
    modelId: agentRecord.modelId ?? 'unknown',
    provider: providerConfig.provider,
    pingIntervalSec: liveness.pingIntervalMs / 1000,
    staleSec: liveness.staleSec,
    wakeMessagePreview: wakeMessage.slice(0, 400),
  });

  try {
    if (isHarnessAdapter(agentRecord.adapterType)) {
      const harnessResult = await runWithHarness(
        agentRecord,
        {
          wake,
          runId,
          apiKey,
          goalId: issueForTask?.goalId ?? undefined,
          projectId: issueForTask?.projectId ?? undefined,
        },
        {
          allowedMcpServerIds: company.allowedMcpServerIds ?? [],
          companySettings: parseCompanySettings(company.settings),
          abortSignal: abortController.signal,
        },
      );

      await logIssueStateAfterRun(runTracer, taskId);
      await parkNoProgressIssue(runId, runTracer, agentRecord.id, companyId, taskId);
      await recordHarnessResult(
        runId,
        agentRecord,
        companyId,
        providerConfig.provider,
        harnessResult,
      );

      if (
        harnessResult.finishReason === 'timeout' ||
        harnessResult.finishReason === 'error' ||
        harnessResult.finishReason === 'max_steps' ||
        harnessResult.finishReason === 'repeated_tool_loop'
      ) {
        const { staleSec } = resolveHeartbeatLivenessConfig();
        let errorText: string;
        switch (harnessResult.finishReason) {
          case 'timeout':
            errorText = heartbeatStaleErrorText(staleSec);
            break;
          case 'max_steps':
            errorText = 'Heartbeat exceeded maxSteps limit';
            break;
          case 'repeated_tool_loop':
            errorText = 'Repeated tool loop detected';
            break;
          default:
            errorText = 'Harness run failed';
            break;
        }
        return { runId, status: 'failed', errorText };
      }

      runTracer.info('harness wake succeeded', {
        finishReason: harnessResult.finishReason,
        traceId: harnessResult.traceId,
      });
      return { runId, status: 'succeeded' };
    }

    await runDurableAgentWake({
      agentRecord,
      wake,
      runId,
      runTracer,
      apiKey,
      wakeMessage,
      abortSignal: abortController.signal,
      taskId,
      issueForTask,
      providerConfig,
      companyId,
      generationOptions,
    });
    return { runId, status: 'succeeded' };
  } catch (err) {
    const errorText = resolveHeartbeatFailureError(err, abortController.signal.aborted);
    runTracer.error('wake run failed', {
      error: errorText,
      aborted: abortController.signal.aborted,
      durationMs: Date.now() - runStartedMs,
    });
    await parkNoProgressIssue(runId, runTracer, agentId, companyId, taskId);
    await recordHeartbeatFailure(runId, errorText, companyId, agentId);
    return { runId, status: 'failed', errorText };
  } finally {
    if (watchdog) clearTimeout(watchdog);
    clearInterval(pingInterval);
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
        errorText: null,
        traceId: result.traceId ?? undefined,
        harnessRunId: result.harnessRunId ?? undefined,
      })
      .where(eq(heartbeatRuns.id, runId));

    if (isMastraTracingEnabled()) {
      await flushObservability();
    }
    return;
  }

  if (result.finishReason === 'timeout') {
    const { staleSec } = resolveHeartbeatLivenessConfig();
    await recordHeartbeatFailure(
      runId,
      heartbeatStaleErrorText(staleSec),
      companyId,
      agentRecord.id,
    );
    return;
  }

  if (result.finishReason === 'error') {
    await recordHeartbeatFailure(runId, 'Harness run failed', companyId, agentRecord.id);
    return;
  }

  if (result.finishReason === 'max_steps') {
    await recordHeartbeatFailure(runId, 'Heartbeat exceeded maxSteps limit', companyId, agentRecord.id);
    return;
  }

  if (result.finishReason === 'repeated_tool_loop') {
    await recordHeartbeatFailure(runId, 'Repeated tool loop detected', companyId, agentRecord.id);
    return;
  }

  await recordHeartbeatSuccess(runId, agentRecord, companyId, provider, {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    traceId: result.traceId,
  });
}

async function runDurableAgentWake(params: {
  agentRecord: AgentRecord;
  wake: WakeRequest;
  runId: string;
  runTracer: WakeTracer;
  apiKey: string;
  wakeMessage: string;
  abortSignal: AbortSignal;
  taskId?: string;
  issueForTask: Awaited<ReturnType<typeof db.query.issues.findFirst>> | undefined;
  providerConfig: ReturnType<typeof resolveModelProviderConfig>;
  companyId: string;
  generationOptions?: AgentGenerationOptions;
}): Promise<void> {
  const {
    agentRecord,
    wake,
    runId,
    runTracer,
    apiKey,
    wakeMessage,
    abortSignal,
    taskId,
    issueForTask,
    providerConfig,
    companyId,
    generationOptions,
  } = params;

  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  const runtimeConfig = agentRecord.runtimeConfig as AgentRuntimeConfig;
  const companySettings = parseCompanySettings(company?.settings);
  const maxSteps = runtimeConfig.heartbeat?.maxSteps ?? 30;
  const durableAgent = await createDurableAgentWithSkills(agentRecord, {
    allowedMcpServerIds: company?.allowedMcpServerIds ?? [],
    companySettings,
    maxSteps,
  });

  const runtimeContext = createHeartbeatRuntimeContext({
    apiKey,
    runId,
    agentId: agentRecord.id,
    companyId,
    taskId,
    goalId: issueForTask?.goalId ?? undefined,
    projectId: issueForTask?.projectId ?? undefined,
    jobId: runId,
    agentRuntimeConfig: agentRecord.runtimeConfig as AgentRuntimeConfig,
  });

  const resumable = await getResumableDurableRun(agentRecord.id, taskId);
  const useMemory = shouldUseHeartbeatMemory(taskId, companySettings);
  const useIdleThread = !taskId && useMemory;

  const memoryKeys = buildHeartbeatMemoryKeys({
    companyId,
    agentId: agentRecord.id,
    issueId: taskId,
    goalId: issueForTask?.goalId ?? undefined,
    projectId: issueForTask?.projectId ?? undefined,
    useIdleThread,
  });

  if (!resumable && !useMemory) {
    await clearInboxThread(companyId, agentRecord.id);
    runTracer.info('cleared inbox thread for stateless wake');
  }

  runTracer.info('wake memory', {
    useMemory,
    thread: useMemory ? memoryKeys.thread : undefined,
  });

  const tracingOptions = buildHeartbeatTracingOptions({
    companyId,
    agentId: agentRecord.id,
    agentUrlKey: agentRecord.urlKey,
    wakeReason: wake.wakeReason,
    heartbeatRunId: runId,
    issueId: taskId,
    goalId: issueForTask?.goalId ?? undefined,
    projectId: issueForTask?.projectId ?? undefined,
  });

  let inputTokens = 0;
  let outputTokens = 0;
  let traceId: string | undefined;
  let durableRunId: string | undefined;
  let streamResult: { cleanup: () => void } | undefined;

  const onAbort = () => {
    streamResult?.cleanup();
  };
  abortSignal.addEventListener('abort', onAbort);

  try {
    if (resumable?.durableRunId) {
      runTracer.info('resuming durable agent run', { durableRunId: resumable.durableRunId });
      const observed = await durableAgent.observe(resumable.durableRunId, {
        offset: 0,
        abortSignal,
        onFinish: (result) => {
          const usage = (result.totalUsage ?? result.usage) as {
            inputTokens?: number;
            outputTokens?: number;
            promptTokens?: number;
            completionTokens?: number;
          } | undefined;
          inputTokens = usage?.inputTokens ?? usage?.promptTokens ?? inputTokens;
          outputTokens = usage?.outputTokens ?? usage?.completionTokens ?? outputTokens;
        },
      } as NonNullable<Parameters<typeof durableAgent.observe>[1]> & { abortSignal: AbortSignal });
      streamResult = observed;
      durableRunId = observed.runId;
      traceId = observed.runId;
      await awaitWithAbort(observed.output.text, abortSignal);
      
      // Check for tripwire in the actual ModelOutput
      const tripwireData = await Promise.resolve(observed.output.tripwire);
      const outcome = durableWakeOutcomeFromTripwire(tripwireData);
      
      if (!outcome.recordSuccess) {
        runTracer.error('system-message tripwire detected', { errorText: outcome.errorText });
        throw new Error(outcome.errorText);
      }
      
      observed.cleanup();
      streamResult = undefined;
    } else {
      const streamed = await durableAgent.stream(wakeMessage, {
        requestContext: runtimeContext,
        maxSteps,
        ...(useMemory
          ? {
              memory: {
                resource: memoryKeys.resource,
                thread: memoryKeys.thread,
              },
            }
          : {}),
        ...toMastraCallOptions(generationOptions ?? {}),
        ...(tracingOptions ? { tracingOptions } : {}),
        abortSignal,
        onFinish: (result) => {
          const usage = (result.totalUsage ?? result.usage) as {
            inputTokens?: number;
            outputTokens?: number;
            promptTokens?: number;
            completionTokens?: number;
          } | undefined;
          inputTokens = usage?.inputTokens ?? usage?.promptTokens ?? 0;
          outputTokens = usage?.outputTokens ?? usage?.completionTokens ?? 0;
        },
      } as NonNullable<Parameters<typeof durableAgent.stream>[1]> & { abortSignal: AbortSignal });
      streamResult = streamed;
      durableRunId = streamed.runId;
      traceId = streamed.runId;
      await awaitWithAbort(streamed.output.text, abortSignal);
      
      // Check for tripwire in the actual ModelOutput
      const tripwireData = await Promise.resolve(streamed.output.tripwire);
      const outcome = durableWakeOutcomeFromTripwire(tripwireData);
      
      if (!outcome.recordSuccess) {
        runTracer.error('system-message tripwire detected', { errorText: outcome.errorText });
        throw new Error(outcome.errorText);
      }
      
      streamed.cleanup();
      streamResult = undefined;
    }
  } catch (err) {
    streamResult?.cleanup();
    streamResult = undefined;
    if (abortSignal.aborted || isAbortLikeError(err)) {
      throw heartbeatAbortedError();
    }
    throw err;
  } finally {
    abortSignal.removeEventListener('abort', onAbort);
  }

  if (durableRunId) {
    await persistDurableRunId(runId, durableRunId);
  }

  await logIssueStateAfterRun(runTracer, taskId);
  await parkNoProgressIssue(runId, runTracer, agentRecord.id, companyId, taskId);

  await recordHeartbeatSuccess(runId, agentRecord, companyId, providerConfig.provider, {
    inputTokens,
    outputTokens,
    traceId,
  });

  runTracer.info('durable agent wake succeeded', { traceId, durableRunId });
}

async function logIssueStateAfterRun(runTracer: WakeTracer, taskId?: string): Promise<void> {
  if (!taskId) return;
  const issueAfter = await db.query.issues.findFirst({ where: eq(issues.id, taskId) });
  runTracer.info('issue state after wake', {
    taskId,
    found: Boolean(issueAfter),
    status: issueAfter?.status,
    checkoutRunId: issueAfter?.checkoutRunId,
    updatedAt: issueAfter?.updatedAt?.toISOString(),
  });
}

async function parkNoProgressIssue(
  runId: string,
  runTracer: WakeTracer,
  agentId: string,
  companyId: string,
  taskId?: string,
): Promise<void> {
  const issueToCheck = await findIssueToPark(runId, agentId, companyId, taskId);

  if (!issueToCheck) {
    runTracer.info('park check: no issue to check', { taskId, hadCheckout: !taskId });
    return;
  }

  // Only park if still in_progress and locked by this run
  if (!shouldParkIssue(issueToCheck, runId)) {
    runTracer.info('park check: skipped — status or lock changed', {
      issueId: issueToCheck.id,
      status: issueToCheck.status,
      checkoutRunId: issueToCheck.checkoutRunId,
    });
    return;
  }

  // Check for material work: updateIssue calls (status/comment), subtasks
  const materialWork = await hasMaterialWork(issueToCheck, runId);

  if (materialWork) {
    runTracer.info('park check: skipped — material work detected', {
      issueId: issueToCheck.id,
    });
    return;
  }

  // No material work: park the issue
  runTracer.warn('parking no-progress issue', {
    issueId: issueToCheck.id,
    identifier: issueToCheck.identifier,
    title: issueToCheck.title,
  });

  await db.transaction(async (tx) => {
    await tx
      .update(issues)
      .set({
        status: 'todo',
        checkoutRunId: null,
        executionLockedAt: null,
        executionAgentNameKey: null,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issueToCheck.id));

    await tx.insert(activityLog).values({
      companyId: issueToCheck.companyId,
      actorType: 'system',
      actorId: 'wake-runner',
      action: 'issue.updated',
      entityType: 'issue',
      entityId: issueToCheck.id,
      details: {
        runId,
        previousStatus: 'in_progress',
        newStatus: 'todo',
        comment: '⏸️ Parked: no material progress after checkout. Higher-priority work may now proceed.',
        reason: 'auto_park_no_progress',
      },
    });
  });
}

function buildRunScopedApiKey(runId: string, agentId: string, companyId: string): string {
  const payload = JSON.stringify({ runId, agentId, companyId, iat: Date.now() });
  return `pm_run_${Buffer.from(payload).toString('base64url')}`;
}

/** Mark abandoned running rows as failed (DB-only stale sweep). */
export async function sweepStaleHeartbeatRuns(): Promise<number> {
  const { staleSec } = resolveHeartbeatLivenessConfig();
  const cutoff = new Date(Date.now() - staleSec * 1000);
  const stale = await db
    .update(heartbeatRuns)
    .set({
      status: 'failed',
      finishedAt: new Date(),
      errorText: heartbeatStaleErrorText(staleSec),
    })
    .where(and(eq(heartbeatRuns.status, 'running'), lt(heartbeatRuns.lastSeenAt, cutoff)))
    .returning({ id: heartbeatRuns.id });
  return stale.length;
}
