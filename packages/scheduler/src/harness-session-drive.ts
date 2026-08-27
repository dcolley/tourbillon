import type { Session, AgentControllerEvent } from '@tourbillon/mastra';
import type { TourbillonControllerState } from '@tourbillon/mastra';
import type { buildHeartbeatTracingOptions } from '@tourbillon/mastra';
import {
  heartbeatProgressStaleErrorText,
  isTokenLimiterTripwireError,
  extractTripwireTokenCounts,
  formatSystemMessageTripwireError,
  resolveHeartbeatLivenessConfig,
} from '@tourbillon/shared';
import { heartbeatAbortedError } from './heartbeat-abort';

export interface HarnessDriveResult {
  inputTokens: number;
  outputTokens: number;
  finishReason: 'complete' | 'suspended' | 'error' | 'timeout' | 'max_steps' | 'repeated_tool_loop';
  suspendedToolCallId?: string;
}

/** Controller events that count as forward progress for the sliding watchdog. */
export function isHarnessProgressEvent(event: AgentControllerEvent): boolean {
  switch (event.type) {
    case 'agent_start':
    case 'agent_end':
    case 'tool_start':
    case 'tool_end':
    case 'tool_suspended':
    case 'tool_approval_required':
    case 'tool_input_start':
    case 'tool_input_end':
    case 'usage_update':
    case 'message_update':
    case 'message_start':
    case 'message_end':
    case 'om_observation_start':
    case 'om_observation_end':
    case 'om_observation_failed':
    case 'om_reflection_start':
    case 'om_reflection_end':
    case 'om_reflection_failed':
    case 'om_buffering_start':
    case 'om_buffering_end':
    case 'error':
      return true;
    default:
      return event.type.startsWith('om_');
  }
}

export function tripwireErrorFromUnknown(err: unknown): Error {
  if (isTokenLimiterTripwireError(err)) {
    // Try to extract token counts from the error
    const counts = extractTripwireTokenCounts(err);
    return new Error(formatSystemMessageTripwireError(counts.systemTokens, counts.limit));
  }
  const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  return err instanceof Error ? err : new Error(message);
}

/**
 * Drive a headless Session until agent_end / suspend / error / abort / progress stale / max steps / repeated tool loop.
 */
export async function driveSessionHeadless(
  session: Session<TourbillonControllerState>,
  wakeMessage: string,
  requestContext: unknown,
  onEvent: (event: AgentControllerEvent) => void,
  abortSignal?: AbortSignal,
  tracingOptions?: ReturnType<typeof buildHeartbeatTracingOptions>,
  progressStaleSec?: number,
  maxSteps?: number,
  timeoutSec?: number,
): Promise<HarnessDriveResult> {
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: HarnessDriveResult['finishReason'] = 'complete';
  let suspendedToolCallId: string | undefined;

  const liveness = resolveHeartbeatLivenessConfig();
  const staleSec = progressStaleSec ?? liveness.progressStaleSec;

  return new Promise((resolve, reject) => {
    let unsub: (() => void) | undefined;
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
    let wallClockTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let lastEvent: { type: string; at: Date } | null = null;
    let modelStepCount = 0;
    const recentToolNames: string[] = [];
    const REPEATED_TOOL_BREAKER_THRESHOLD = 5;

    const cleanup = () => {
      if (progressTimer) clearTimeout(progressTimer);
      if (wallClockTimer) clearTimeout(wallClockTimer);
      abortSignal?.removeEventListener('abort', onAbort);
      unsub?.();
    };

    const finish = (result: HarnessDriveResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const resetProgressWatchdog = () => {
      if (progressTimer) clearTimeout(progressTimer);
      progressTimer = setTimeout(() => {
        try {
          session.abort();
        } catch {
          // ignore
        }
        fail(new Error(heartbeatProgressStaleErrorText(staleSec, lastEvent)));
      }, staleSec * 1000);
    };

    const onAbort = () => {
      session.abort();
      fail(heartbeatAbortedError());
    };

    abortSignal?.addEventListener('abort', onAbort, { once: true });
    resetProgressWatchdog();

    if (timeoutSec && timeoutSec > 0) {
      wallClockTimer = setTimeout(() => {
        try {
          session.abort();
        } catch {
          // ignore
        }
        fail(new Error(`Heartbeat exceeded wall-clock timeout of ${timeoutSec}s`));
      }, timeoutSec * 1000);
    }

    unsub = session.subscribe((event) => {
      lastEvent = { type: event.type, at: new Date() };
      onEvent(event);

      if (isHarnessProgressEvent(event)) {
        resetProgressWatchdog();
      }

      switch (event.type) {
        case 'message_start':
          modelStepCount += 1;
          if (maxSteps && modelStepCount > maxSteps) {
            session.abort();
            finishReason = 'max_steps';
            onEvent({
              type: 'error',
              error: new Error(`Heartbeat exceeded maxSteps limit of ${maxSteps}`),
            } as AgentControllerEvent);
            finish({ inputTokens, outputTokens, finishReason, suspendedToolCallId });
            return;
          }
          break;

        case 'tool_start': {
          const toolName = (event as { toolName?: string }).toolName;
          if (toolName) {
            recentToolNames.push(toolName);
            if (recentToolNames.length > REPEATED_TOOL_BREAKER_THRESHOLD) {
              recentToolNames.shift();
            }

            if (recentToolNames.length >= REPEATED_TOOL_BREAKER_THRESHOLD) {
              const allSame = recentToolNames.every((name) => name === recentToolNames[0]);
              if (allSame) {
                session.abort();
                finishReason = 'repeated_tool_loop';
                onEvent({
                  type: 'error',
                  error: new Error(
                    `Repeated tool loop detected: ${toolName} called ${REPEATED_TOOL_BREAKER_THRESHOLD} times in a row`,
                  ),
                } as AgentControllerEvent);
                finish({ inputTokens, outputTokens, finishReason, suspendedToolCallId });
                return;
              }
            }
          }
          break;
        }

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

        case 'error': {
          const err = event.error;
          if (isTokenLimiterTripwireError(err)) {
            fail(tripwireErrorFromUnknown(err));
          } else {
            fail(err instanceof Error ? err : new Error(String(err)));
          }
          break;
        }

        case 'om_observation_failed':
        case 'om_reflection_failed':
          // Compaction failure is logged via observability; do not fail the wake.
          break;

        default:
          break;
      }
    });

    void session
      .sendMessage({
        content: wakeMessage,
        requestContext: requestContext as never,
        tracingOptions: tracingOptions ?? undefined,
      })
      .then(() => {
        if (!session.run.isRunning()) {
          finish({ inputTokens, outputTokens, finishReason: 'complete', suspendedToolCallId });
        }
      })
      .catch((err) => {
        fail(tripwireErrorFromUnknown(err));
      });
  });
}
