import type { Agent as AgentRecord } from '@tourbillon/db';
import {
  createHeartbeatRuntimeContext,
  buildControllerCwd,
  buildControllerThreadId,
  createTourbillonController,
  ensureControllerThread,
  clearHarnessIdleThread,
  type AgentControllerEvent,
  CONTROLLER_THREAD_MESSAGE_CAP,
  getResumableHarnessRun,
  persistHarnessRunId,
  writeHarnessObservabilityEvent,
  type HarnessObservabilityContext,
  buildHeartbeatTracingOptions,
  createHeartbeatTraceId,
} from '@tourbillon/mastra';
import type { HeartbeatJobData, AgentRuntimeConfig } from '@tourbillon/shared';
import {
  buildWakeMessage,
  isHarnessAdapter,
  isMastraTracingEnabled,
  isObservabilityEnabled,
  isObservationalMemoryConfigured,
  type CompanySettings,
} from '@tourbillon/shared';
import { driveSessionHeadless } from '../harness-session-drive';

export interface HarnessRunContext {
  wake: HeartbeatJobData;
  runId: string;
  apiKey: string;
  goalId?: string;
  projectId?: string;
}

export interface HarnessRunResult {
  threadId: string;
  harnessRunId?: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: 'complete' | 'suspended' | 'error' | 'timeout' | 'max_steps' | 'repeated_tool_loop';
  suspendedToolCallId?: string;
  traceId?: string;
}

/**
 * Drive a headless AgentController Session for a harness_local heartbeat.
 * Wire names (`runWithHarness`, `harnessRunId`) stay for Phase 1 compatibility.
 */
export async function runWithHarness(
  agentRecord: AgentRecord,
  context: HarnessRunContext,
  options: {
    allowedMcpServerIds: string[];
    companySettings?: CompanySettings | null;
    abortSignal?: AbortSignal;
  },
): Promise<HarnessRunResult> {
  if (!isHarnessAdapter(agentRecord.adapterType)) {
    throw new Error(`Agent ${agentRecord.id} is not configured for harness execution`);
  }

  const { wake, runId, apiKey, goalId, projectId } = context;
  const taskId = wake.taskId;
  const cwd = await buildControllerCwd(agentRecord, taskId);

  const controller = await createTourbillonController(agentRecord, {
    allowedMcpServerIds: options.allowedMcpServerIds,
    companySettings: options.companySettings ?? null,
    cwd,
  });

  await controller.init();

  const resumable = await getResumableHarnessRun(agentRecord.id, taskId);
  const omEnabled = isObservationalMemoryConfigured(options.companySettings);
  if (!resumable && !taskId && !omEnabled) {
    await clearHarnessIdleThread(agentRecord.id);
  }
  const threadId = resumable?.threadId ?? buildControllerThreadId(agentRecord, taskId);

  const session = await controller.createSession({
    resourceId: `company-${agentRecord.companyId}`,
    id: `hb-${runId}`,
    ownerId: agentRecord.id,
  });
  await ensureControllerThread(session, threadId);

  const runtimeContext = createHeartbeatRuntimeContext({
    apiKey,
    runId,
    agentId: agentRecord.id,
    companyId: agentRecord.companyId,
    taskId,
    goalId,
    projectId,
    jobId: runId,
    agentRuntimeConfig: agentRecord.runtimeConfig as AgentRuntimeConfig,
  });

  // Hex-only id so harness UI events and Mastra/Phoenix spans share one trace.
  const traceId = createHeartbeatTraceId();
  const tracingOptions = buildHeartbeatTracingOptions({
    companyId: agentRecord.companyId,
    agentId: agentRecord.id,
    agentUrlKey: agentRecord.urlKey,
    wakeReason: wake.wakeReason,
    heartbeatRunId: runId,
    issueId: taskId,
    goalId,
    projectId,
    traceId,
  });

  const toolCallNames = new Map<string, string>();
  const observabilityCtx: HarnessObservabilityContext | null = isObservabilityEnabled()
    ? {
        companyId: agentRecord.companyId,
        agentId: agentRecord.id,
        issueId: taskId,
        goalId,
        projectId,
        heartbeatRunId: runId,
        jobId: runId,
        traceId,
        toolCallNames,
      }
    : null;

  let harnessRunIdWritten = false;
  const onEvent = (event: AgentControllerEvent) => {
    const currentRunId = session.getCurrentRunId();
    if (currentRunId && !harnessRunIdWritten) {
      harnessRunIdWritten = true;
      void persistHarnessRunId(runId, currentRunId, threadId);
    }
    if (observabilityCtx) {
      writeHarnessObservabilityEvent(observabilityCtx, event);
    }
  };

  const runtimeConfig = agentRecord.runtimeConfig as AgentRuntimeConfig;
  const maxSteps = runtimeConfig.heartbeat?.maxSteps ?? 30;
  const timeoutSec = runtimeConfig.timeout?.heartbeatSec ?? 300;

  try {
    const result = await driveSessionHeadless(
      session,
      buildWakeMessage(wake),
      runtimeContext,
      onEvent,
      options.abortSignal,
      tracingOptions,
      undefined,
      maxSteps,
      timeoutSec,
    );

    const harnessRunId = session.getCurrentRunId() ?? undefined;
    if (harnessRunId) {
      await persistHarnessRunId(runId, harnessRunId, threadId);
    }

    const resolvedTraceId =
      (isMastraTracingEnabled() ? session.run.getTraceId() : null) ?? traceId;

    return { ...result, threadId, harnessRunId, traceId: resolvedTraceId };
  } finally {
    await controller.destroy().catch(() => undefined);
  }
}

/** Limit message history when listing threads (controller storage cap). */
export function harnessMessageLimit(): number {
  return CONTROLLER_THREAD_MESSAGE_CAP;
}

export { driveSessionHeadless, isHarnessProgressEvent, tripwireErrorFromUnknown } from '../harness-session-drive';
