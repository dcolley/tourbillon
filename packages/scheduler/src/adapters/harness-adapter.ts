import type { Agent as AgentRecord } from '@tourbillon/db';
import {
  createHeartbeatRuntimeContext,
  buildControllerCwd,
  buildControllerThreadId,
  createTourbillonController,
  ensureControllerThread,
  clearHarnessIdleThread,
  type TourbillonControllerState,
  type Session,
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
  type CompanySettings,
} from '@tourbillon/shared';
import { heartbeatAbortedError } from '../heartbeat-abort';

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
  finishReason: 'complete' | 'suspended' | 'error' | 'timeout';
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
  if (!resumable && !taskId) {
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

  try {
    const result = await driveSessionHeadless(
      session,
      buildWakeMessage(wake),
      runtimeContext,
      onEvent,
      options.abortSignal,
      tracingOptions,
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

async function driveSessionHeadless(
  session: Session<TourbillonControllerState>,
  wakeMessage: string,
  requestContext: ReturnType<typeof createHeartbeatRuntimeContext>,
  onEvent: (event: AgentControllerEvent) => void,
  abortSignal?: AbortSignal,
  tracingOptions?: ReturnType<typeof buildHeartbeatTracingOptions>,
): Promise<Omit<HarnessRunResult, 'threadId' | 'harnessRunId' | 'traceId'>> {
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: HarnessRunResult['finishReason'] = 'complete';
  let suspendedToolCallId: string | undefined;

  return new Promise((resolve, reject) => {
    let unsub: (() => void) | undefined;

    const finish = (result: Omit<HarnessRunResult, 'threadId' | 'harnessRunId' | 'traceId'>) => {
      abortSignal?.removeEventListener('abort', onAbort);
      unsub?.();
      resolve(result);
    };

    const fail = (err: Error) => {
      abortSignal?.removeEventListener('abort', onAbort);
      unsub?.();
      reject(err);
    };

    const onAbort = () => {
      session.abort();
      fail(heartbeatAbortedError());
    };

    abortSignal?.addEventListener('abort', onAbort, { once: true });

    unsub = session.subscribe((event) => {
      onEvent(event);

      switch (event.type) {
        case 'usage_update':
          inputTokens += event.usage.promptTokens ?? 0;
          outputTokens += event.usage.completionTokens ?? 0;
          break;

        case 'agent_end':
          if (event.reason === 'suspended') {
            suspendedToolCallId = session.getCurrentRunId() ?? undefined;
            finishReason = 'suspended';
          } else if (event.reason === 'error') {
            finishReason = 'error';
          } else {
            finishReason = 'complete';
          }
          finish({ inputTokens, outputTokens, finishReason, suspendedToolCallId });
          break;

        case 'tool_suspended':
          suspendedToolCallId = event.toolCallId;
          finishReason = 'suspended';
          finish({ inputTokens, outputTokens, finishReason, suspendedToolCallId });
          break;

        case 'error':
          fail(event.error);
          break;

        default:
          break;
      }
    });

    void session
      .sendMessage({
        content: wakeMessage,
        requestContext,
        tracingOptions: tracingOptions ?? undefined,
      })
      .then(() => {
        if (!session.run.isRunning()) {
          finish({ inputTokens, outputTokens, finishReason: 'complete', suspendedToolCallId });
        }
      })
      .catch((err) => {
        fail(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

/** Limit message history when listing threads (controller storage cap). */
export function harnessMessageLimit(): number {
  return CONTROLLER_THREAD_MESSAGE_CAP;
}
