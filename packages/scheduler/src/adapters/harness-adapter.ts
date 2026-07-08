import type { Job } from 'bullmq';
import type { Harness } from '@mastra/core/harness';
import type { HarnessEvent } from '@mastra/core/harness';
import type { Agent as AgentRecord } from '@tourbillon/db';
import {
  createHeartbeatRuntimeContext,
  buildHarnessCwd,
  buildHarnessThreadId,
  createTourbillonHarness,
  ensureHarnessThread,
  clearHarnessIdleThread,
  type TourbillonHarnessState,
  HARNESS_THREAD_MESSAGE_CAP,
  getResumableHarnessRun,
  persistHarnessRunId,
  writeHarnessObservabilityEvent,
  type HarnessObservabilityContext,
} from '@tourbillon/mastra';
import type { HeartbeatJobData, AgentRuntimeConfig } from '@tourbillon/shared';
import { buildWakeMessage, isHarnessAdapter, isObservabilityEnabled, parseCompanySettings, type CompanySettings } from '@tourbillon/shared';
import { randomUUID } from 'crypto';
import { heartbeatAbortedError } from '../heartbeat-abort';

export interface HarnessRunContext {
  job: Job<HeartbeatJobData>;
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

  const { job, runId, apiKey, goalId, projectId } = context;
  const taskId = job.data.taskId;
  const cwd = await buildHarnessCwd(agentRecord, taskId);

  const harness = await createTourbillonHarness(agentRecord, {
    allowedMcpServerIds: options.allowedMcpServerIds,
    companySettings: options.companySettings ?? null,
    cwd,
  });

  await harness.init();

  const resumable = await getResumableHarnessRun(agentRecord.id, taskId);
  if (!resumable && !taskId) {
    await clearHarnessIdleThread(agentRecord.id);
  }
  const threadId = resumable?.threadId ?? buildHarnessThreadId(agentRecord, taskId);
  await ensureHarnessThread(harness, threadId);

  const runtimeContext = createHeartbeatRuntimeContext({
    apiKey,
    runId,
    agentId: agentRecord.id,
    companyId: agentRecord.companyId,
    taskId,
    goalId,
    projectId,
    jobId: job.id ?? undefined,
    agentRuntimeConfig: agentRecord.runtimeConfig as AgentRuntimeConfig,
  });

  const traceId = randomUUID();
  const toolCallNames = new Map<string, string>();
  const observabilityCtx: HarnessObservabilityContext | null = isObservabilityEnabled()
    ? {
        companyId: agentRecord.companyId,
        agentId: agentRecord.id,
        issueId: taskId,
        goalId,
        projectId,
        heartbeatRunId: runId,
        jobId: job.id ?? undefined,
        traceId,
        toolCallNames,
      }
    : null;

  let harnessRunIdWritten = false;
  const onEvent = (event: HarnessEvent) => {
    const currentRunId = harness.getCurrentRunId();
    if (currentRunId && !harnessRunIdWritten) {
      harnessRunIdWritten = true;
      void persistHarnessRunId(runId, currentRunId, threadId);
    }
    if (observabilityCtx) {
      writeHarnessObservabilityEvent(observabilityCtx, event);
    }
  };

  try {
    const result = await driveHarnessHeadless(
      harness,
      buildWakeMessage(job.data),
      runtimeContext,
      onEvent,
      options.abortSignal,
    );

    const harnessRunId = harness.getCurrentRunId() ?? undefined;
    if (harnessRunId) {
      await persistHarnessRunId(runId, harnessRunId, threadId);
    }

    return { ...result, threadId, harnessRunId, traceId };
  } finally {
    await harness.destroy().catch(() => undefined);
  }
}

async function driveHarnessHeadless(
  harness: Harness<TourbillonHarnessState>,
  wakeMessage: string,
  requestContext: ReturnType<typeof createHeartbeatRuntimeContext>,
  onEvent: (event: HarnessEvent) => void,
  abortSignal?: AbortSignal,
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
      fail(heartbeatAbortedError());
    };

    abortSignal?.addEventListener('abort', onAbort, { once: true });

    unsub = harness.subscribe((event) => {
      onEvent(event);

      switch (event.type) {
        case 'usage_update':
          inputTokens += event.usage.promptTokens ?? 0;
          outputTokens += event.usage.completionTokens ?? 0;
          break;

        case 'agent_end':
          if (event.reason === 'suspended') {
            suspendedToolCallId = harness.getCurrentRunId() ?? undefined;
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

    void harness
      .sendMessage({ content: wakeMessage, requestContext })
      .then(() => {
        if (!harness.isRunning()) {
          finish({ inputTokens, outputTokens, finishReason: 'complete', suspendedToolCallId });
        }
      })
      .catch((err) => {
        fail(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

/** Limit message history when listing threads (harness storage cap). */
export function harnessMessageLimit(): number {
  return HARNESS_THREAD_MESSAGE_CAP;
}
