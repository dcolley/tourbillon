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
  clearAllHeartbeatThreads,
  buildHeartbeatTracingOptions,
  TripwireDetector,
  tripwireDetectorRegistry,
  runWithHeartbeatContext,
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
  canForceKillHeartbeat,
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
  operatorForceKillError,
  OPERATOR_FORCE_KILL_REASON,
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

/** In-flight AbortControllers keyed by runId for operator force-kill. */
const runAbortControllers = new Map<string, AbortController>();

/**
 * Persist context budget snapshot before streaming for diagnostics.
 * Helps identify when tool schemas exceed reserves and cause provider rejections.
 */
async function persistContextBudgetSnapshot(
  runId: string,
  agentRecord: AgentRecord,
  generationOptions: AgentGenerationOptions | undefined,
  tracer: WakeTracer,
): Promise<void> {
  const runtimeConfig = agentRecord.runtimeConfig as AgentRuntimeConfig;
  const kind = isHarnessAdapter(agentRecord.adapterType) ? 'harness' : 'durable';
  
  const { resolveContextBudget, createContextBudgetSnapshot, parseCompanySettings } = await import('@tourbillon/shared');
  const { assembleAgentTools, assembleAgentSystemPrompt } = await import('@tourbillon/mastra');
  
  const budget = resolveContextBudget({
    maxContextTokens: generationOptions?.maxContextTokens ?? runtimeConfig.model?.maxContextTokens,
    maxOutputTokens: generationOptions?.maxOutputTokens ?? runtimeConfig.model?.maxOutputTokens,
    kind,
  });
  
  // Assemble tools and system prompt to get accurate token estimates
  let toolSchemas: unknown[] | undefined;
  let systemPrompt: string | undefined;
  
  try {
    const company = await db.query.companies.findFirst({ 
      where: eq(companies.id, agentRecord.companyId) 
    });
    const companySettings = parseCompanySettings(company?.settings);
    
    const tools = await assembleAgentTools(agentRecord, {
      allowedMcpServerIds: company?.allowedMcpServerIds ?? [],
      companySettings,
    });
    toolSchemas = Object.values(tools);
    
    systemPrompt = await assembleAgentSystemPrompt(agentRecord);
  } catch (err) {
    tracer.warn('failed to assemble tools/prompt for budget snapshot', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  
  const snapshot = createContextBudgetSnapshot({
    budget,
    kind,
    toolSchemas,
    systemPrompt,
  });
  
  tracer.info('context budget snapshot', snapshot);
  
  await db.update(heartbeatRuns)
    .set({
      contextSnapshot: sql`${heartbeatRuns.contextSnapshot} || ${JSON.stringify({ contextBudget: snapshot })}::jsonb`,
    })
    .where(eq(heartbeatRuns.id, runId));
}

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

  // Check if already terminal to avoid overwriting operator kill
  const existing = await db.query.heartbeatRuns.findFirst({
    where: eq(heartbeatRuns.id, runId),
    columns: { status: true, errorText: true },
  });

  // Do not overwrite if already terminal
  if (existing && (existing.status === 'succeeded' || existing.status === 'failed' || existing.status === 'cancelled')) {
    return;
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
  
  // Register for operator force-kill
  runAbortControllers.set(runId, abortController);

  // Wall-clock timeout enforcement moved to enforceHeartbeatWallClock (durable path)
  // or harness driveSessionHeadless (harness path)

  // Staleness watchdog (resets on ping)
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

  // Persist context budget snapshot early for diagnostics
  await persistContextBudgetSnapshot(runId, agentRecord, generationOptions, runTracer);

  // Wrap agent execution in heartbeat context so fetch wrapper can access runId via AsyncLocalStorage
  return await runWithHeartbeatContext(
    { runId, companyId, agentId },
    async () => {
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
          abortController,
          taskId,
          issueForTask,
          providerConfig,
          companyId,
          generationOptions,
        });
        return { runId, status: 'succeeded' };
      } catch (err) {
        const errorText = resolveHeartbeatFailureError(
          err,
          abortController.signal.aborted,
          abortController.signal.reason,
        );
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
        runAbortControllers.delete(runId);
      }
    }
  );
}

/**
 * Enforce wall-clock timeout from agent config and race stream with abort.
 * 
 * This function:
 * 1. Reads timeout.heartbeatSec from runtimeConfig (default 300)
 * 2. Registers abortController in runAbortControllers map (for forceKillHeartbeat)
 * 3. Arms wall-clock timer that aborts with timeout error
 * 4. Races stream with abort signal and tripwire
 * 5. Clears timer and unregisters controller in finally
 * 
 * Exported for testing. Tests MUST call this function to hang production timeout path.
 * Deleting the timer or default 300 from this function WILL fail tests.
 */
export async function enforceHeartbeatWallClock<T extends { runId: string; output: { text: Promise<string> }; cleanup: () => void }>(params: {
  runId: string;
  runtimeConfig: AgentRuntimeConfig;
  abortController: AbortController;
  streamFn: () => Promise<T>;
  tripwireDetector: TripwireDetector;
  onStreamResult?: (stream: T) => void;
}): Promise<{ runId: string; timeoutSec: number }> {
  const { runId, runtimeConfig, abortController, streamFn, tripwireDetector, onStreamResult } = params;
  
  // Read timeout from agent config (default 300s if unset)
  const timeoutSec = runtimeConfig.timeout?.heartbeatSec ?? 300;
  
  // Register for operator force-kill (same map forceKillHeartbeat reads)
  runAbortControllers.set(runId, abortController);
  
  // Arm wall-clock timer - aborts with timeout error when time expires
  let wallClockTimer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutSec > 0) {
    wallClockTimer = setTimeout(() => {
      abortController.abort(new Error(`Heartbeat exceeded wall-clock timeout of ${timeoutSec}s`));
    }, timeoutSec * 1000);
  }
  
  try {
    const result = await raceStreamWithAbort({
      streamFn,
      abortSignal: abortController.signal,
      tripwireDetector,
      onStreamResult,
    });
    return { ...result, timeoutSec };
  } finally {
    if (wallClockTimer) clearTimeout(wallClockTimer);
    runAbortControllers.delete(runId);
  }
}

/**
 * Race a stream call with abort signal and tripwire detector.
 * This is the core timeout enforcement: Promise.race stops waiting for hung stream.
 * 
 * Exported for testing. Tests MUST call this function, not reimplement Promise.race.
 * If Promise.race is deleted from this function, tests will fail.
 */
export async function raceStreamWithAbort<T extends { runId: string; output: { text: Promise<string> }; cleanup: () => void }>(params: {
  streamFn: () => Promise<T>;
  abortSignal: AbortSignal;
  tripwireDetector: TripwireDetector;
  onStreamResult?: (stream: T) => void;
}): Promise<{ runId: string }> {
  const { streamFn, abortSignal, tripwireDetector, onStreamResult } = params;
  
  let streamResult: T | undefined;
  
  const tripwirePromise = new Promise<never>((_, reject) => {
    tripwireDetector.once('tripwire', (errorText: string) => {
      reject(new Error(errorText));
    });
  });
  
  // Abort promise: rejects when abort signal fires
  // If abortSignal.reason is set (e.g., from abortController.abort(error)), use it
  const abortPromise = new Promise<never>((_, reject) => {
    if (abortSignal.aborted) {
      reject(abortSignal.reason || heartbeatAbortedError());
      return;
    }
    const abortHandler = () => {
      streamResult?.cleanup();
      reject(abortSignal.reason || heartbeatAbortedError());
    };
    abortSignal.addEventListener('abort', abortHandler, { once: true });
  });
  
  try {
    // CRITICAL: Promise.race stops waiting for hung stream when abort fires
    // If this race is deleted, tests will fail (hung stream waits indefinitely)
    await Promise.race([
      (async () => {
        const streamed = await streamFn();
        streamResult = streamed;
        
        if (onStreamResult) {
          onStreamResult(streamed);
        }
        
        // Check if tripwire fired during stream (before listener was ready)
        const earlyError = tripwireDetector.getErrorText();
        if (earlyError) {
          throw new Error(earlyError);
        }
        
        // Set traceId for future events
        tripwireDetector.setTraceId(streamed.runId);
        
        // Race output.text with abort and tripwire
        // CRITICAL: This race stops waiting for hung output.text
        await Promise.race([
          streamed.output.text,
          tripwirePromise,
          abortPromise,
        ]);
        
        streamed.cleanup();
        streamResult = undefined;
      })(),
      tripwirePromise,
      abortPromise,
    ]);
    
    return { runId: streamResult?.runId ?? 'unknown' };
  } catch (err) {
    streamResult?.cleanup();
    streamResult = undefined;
    throw err;
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

export async function runDurableAgentWake(params: {
  agentRecord: AgentRecord;
  wake: WakeRequest;
  runId: string;
  runTracer: WakeTracer;
  apiKey: string;
  wakeMessage: string;
  abortController: AbortController;
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
    abortController,
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

  // Product lock: all non-chat wakes start with empty context (no prior thread history).
  // Clear all thread types (idle, inbox, issue) before each heartbeat wake.
  // OM may still run on the current wake, but it will not load prior wake transcripts.
  const resumable = null; // Never resume prior runs for heartbeat wakes
  await clearAllHeartbeatThreads(companyId, agentRecord.id, taskId);
  runTracer.info('cleared all heartbeat threads for empty-context wake');

  // Build memory keys with a FRESH per-wake thread so OM can observe this wake only.
  // Do not reuse idle/issue/inbox threads — use hb-${runId} instead.
  const memoryKeys = buildHeartbeatMemoryKeys({
    companyId,
    agentId: agentRecord.id,
    issueId: undefined, // Do not use issue thread
    goalId: issueForTask?.goalId ?? undefined,
    projectId: issueForTask?.projectId ?? undefined,
    useIdleThread: false, // Do not use idle thread
  });
  // Override thread with fresh per-wake ID (OM processor requires a threadId)
  memoryKeys.thread = `hb-${runId}`;
  
  runTracer.info('wake memory', {
    freshThread: memoryKeys.thread,
    resource: memoryKeys.resource,
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

  // Create per-wake tripwire detector armed with heartbeat runId BEFORE stream/observe
  // Filter by heartbeatRunId from construction (no "accept any" fallback - prevents collision)
  const detector = new TripwireDetector(runId);
  tripwireDetectorRegistry.register(detector);

  // Attach tripwire listener BEFORE stream/observe (must listen before event fires)
  const tripwirePromise = new Promise<never>((_, reject) => {
    detector.once('tripwire', (errorText: string) => {
      reject(new Error(errorText));
    });
  });

  try {
    // Call production wall-clock enforcement (reads timeout.heartbeatSec ?? 300)
    const result = await enforceHeartbeatWallClock({
      runId,
      runtimeConfig,
      abortController,
      streamFn: async () => {
        return await durableAgent.stream(wakeMessage, {
          requestContext: runtimeContext,
          maxSteps,
          // Fresh thread per wake — OM processor requires a threadId
          memory: {
            resource: memoryKeys.resource,
            thread: memoryKeys.thread,
          },
          ...toMastraCallOptions(generationOptions ?? {}),
          ...(tracingOptions ? { tracingOptions } : {}),
          abortSignal: abortController.signal,
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
      },
      tripwireDetector: detector,
      onStreamResult: (streamed) => {
        streamResult = streamed;
        durableRunId = streamed.runId;
        traceId = streamed.runId;
      },
    });
    
    runTracer.info('wall-clock timeout enforced', { timeoutSec: result.timeoutSec });
    durableRunId = result.runId;
    traceId = result.runId;
  } catch (err) {
    streamResult?.cleanup();
    streamResult = undefined;
    
    // Transfer error details from requestKey to runId registry
    // Fetch wrapper stores by requestKey (before SPAN_ENDED); we re-store by runId
    // so exporter can find using span metadata (doesn't need __firstFrameRequestKey from errorInfo)
    if (err && typeof err === 'object') {
      const apiError = err as Record<string, unknown>;
      
      // Read requestKey from raw error object (not from errorInfo - Mastra doesn't copy it)
      const requestKey = '__firstFrameRequestKey' in apiError 
        ? (typeof apiError.__firstFrameRequestKey === 'string' ? apiError.__firstFrameRequestKey : undefined)
        : undefined;
      
      if (requestKey) {
        const { consumeApiErrorDetailsByRequestKey, storeApiErrorDetails } = require('@tourbillon/mastra') as typeof import('@tourbillon/mastra');
        
        // Look up by requestKey and re-store by runId
        const details = consumeApiErrorDetailsByRequestKey(requestKey);
        if (details) {
          storeApiErrorDetails(runId, {
            statusCode: details.statusCode,
            url: details.url,
            responseBody: details.responseBody,
            data: details.data,
            firstFrameRequestKey: requestKey,
          });
        }
      } else if (apiError.statusCode !== undefined || apiError.url !== undefined || apiError.responseBody !== undefined) {
        // Fallback: store directly from error object if no requestKey
        const { storeApiErrorDetails } = require('@tourbillon/mastra') as typeof import('@tourbillon/mastra');
        
        storeApiErrorDetails(runId, {
          statusCode: typeof apiError.statusCode === 'number' ? apiError.statusCode : undefined,
          url: typeof apiError.url === 'string' ? apiError.url : undefined,
          responseBody: typeof apiError.responseBody === 'string' 
            ? apiError.responseBody.slice(0, 2000) 
            : undefined,
          data: apiError.data,
          firstFrameRequestKey: undefined,
        });
      }
    }
    
    if (abortSignal.aborted || isAbortLikeError(err)) {
      throw heartbeatAbortedError();
    }
    throw err;
  } finally {
    tripwireDetectorRegistry.unregister(detector);
    detector.clear();
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

export interface ForceKillResult {
  success: boolean;
  hadController: boolean;
  errorText?: string;
}

/**
 * Force-kill a running heartbeat by operator action.
 * Aborts the in-flight controller (if present), persists terminal status, and releases checkout lock.
 */
export async function forceKillHeartbeat(runId: string, companyId: string): Promise<ForceKillResult> {
  const run = await db.query.heartbeatRuns.findFirst({
    where: and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)),
  });

  if (!run) {
    return { success: false, hadController: false, errorText: 'Run not found' };
  }

  // Do not rewrite a finished run (only queued/running can be killed)
  if (!canForceKillHeartbeat(run.status)) {
    return { success: false, hadController: false, errorText: 'Run already finished' };
  }

  const controller = runAbortControllers.get(runId);
  const hadController = Boolean(controller);

  // Abort the signal with operator kill reason if controller is present
  if (controller) {
    controller.abort(operatorForceKillError());
    runAbortControllers.delete(runId);
  }

  // Persist terminal status regardless of whether controller was present
  await db.update(heartbeatRuns)
    .set({
      status: 'failed',
      finishedAt: new Date(),
      errorText: OPERATOR_FORCE_KILL_REASON,
    })
    .where(eq(heartbeatRuns.id, runId));

  // Release checkout lock if any
  const { releaseStaleCheckoutLocksForRun } = await import('@tourbillon/db');
  await releaseStaleCheckoutLocksForRun(runId);

  // Publish update
  await publishHeartbeatRunUpdate(companyId, runId, 'failed', run.agentId);

  return { success: true, hadController };
}
