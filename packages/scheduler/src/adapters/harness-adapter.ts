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
  type TourbillonHarnessState,
  HARNESS_THREAD_MESSAGE_CAP,
  getResumableHarnessRun,
  persistHarnessRunId,
  writeHarnessObservabilityEvent,
  type HarnessObservabilityContext,
} from '@tourbillon/mastra';
import type { HeartbeatJobData } from '@tourbillon/shared';
import { buildWakeMessage, isHarnessAdapter, isObservabilityEnabled } from '@tourbillon/shared';
import { randomUUID } from 'crypto';

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
  timeoutMs: number,
  allowedMcpServerIds: string[],
): Promise<HarnessRunResult> {
  if (!isHarnessAdapter(agentRecord.adapterType)) {
    throw new Error(`Agent ${agentRecord.id} is not configured for harness execution`);
  }

  const { job, runId, apiKey, goalId, projectId } = context;
  const taskId = job.data.taskId;
  const cwd = await buildHarnessCwd(agentRecord, taskId);

  const harness = await createTourbillonHarness(agentRecord, {
    allowedMcpServerIds,
    cwd,
  });

  await harness.init();

  const resumable = await getResumableHarnessRun(agentRecord.id, taskId);
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
      timeoutMs,
      job,
      onEvent,
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
  timeoutMs: number,
  job: Job<HeartbeatJobData>,
  onEvent: (event: HarnessEvent) => void,
): Promise<Omit<HarnessRunResult, 'threadId' | 'harnessRunId' | 'traceId'>> {
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: HarnessRunResult['finishReason'] = 'complete';
  let suspendedToolCallId: string | undefined;

  return new Promise((resolve, reject) => {
    const keepalive = setInterval(() => {
      void job.updateProgress(0).catch(() => undefined);
    }, 20_000);

    const timer = setTimeout(() => {
      clearInterval(keepalive);
      finishReason = 'timeout';
      resolve({ inputTokens, outputTokens, finishReason });
    }, timeoutMs);

    const unsub = harness.subscribe((event) => {
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
          clearTimeout(timer);
          clearInterval(keepalive);
          unsub();
          resolve({ inputTokens, outputTokens, finishReason, suspendedToolCallId });
          break;

        case 'tool_suspended':
          suspendedToolCallId = event.toolCallId;
          finishReason = 'suspended';
          clearTimeout(timer);
          clearInterval(keepalive);
          unsub();
          resolve({ inputTokens, outputTokens, finishReason, suspendedToolCallId });
          break;

        case 'error':
          clearTimeout(timer);
          clearInterval(keepalive);
          unsub();
          reject(event.error);
          break;

        default:
          break;
      }
    });

    void harness
      .sendMessage({ content: wakeMessage, requestContext })
      .then(() => {
        if (!harness.isRunning()) {
          clearTimeout(timer);
          clearInterval(keepalive);
          unsub();
          resolve({ inputTokens, outputTokens, finishReason: 'complete', suspendedToolCallId });
        }
      })
      .catch((err) => {
        clearTimeout(timer);
        clearInterval(keepalive);
        unsub();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

/** Limit message history when listing threads (harness storage cap). */
export function harnessMessageLimit(): number {
  return HARNESS_THREAD_MESSAGE_CAP;
}
