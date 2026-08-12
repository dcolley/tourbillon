import type { Session, AgentControllerEvent } from '@tourbillon/mastra';
import type { TourbillonControllerState } from '@tourbillon/mastra';
import type { buildHeartbeatTracingOptions } from '@tourbillon/mastra';
import {
  heartbeatProgressStaleErrorText,
  isTokenLimiterTripwireError,
  resolveHeartbeatLivenessConfig,
} from '@tourbillon/shared';
import { heartbeatAbortedError } from './heartbeat-abort';

export interface HarnessDriveResult {
  inputTokens: number;
  outputTokens: number;
  finishReason: 'complete' | 'suspended' | 'error' | 'timeout';
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
  const message = err instanceof Error ? err.message : String(err ?? 'Unknown tripwire');
  if (isTokenLimiterTripwireError(err)) {
    return new Error(`TokenLimiter tripwire: ${message}`);
  }
  return err instanceof Error ? err : new Error(message);
}

/**
 * Drive a headless Session until agent_end / suspend / error / abort / progress stale.
 */
export async function driveSessionHeadless(
  session: Session<TourbillonControllerState>,
  wakeMessage: string,
  requestContext: unknown,
  onEvent: (event: AgentControllerEvent) => void,
  abortSignal?: AbortSignal,
  tracingOptions?: ReturnType<typeof buildHeartbeatTracingOptions>,
  progressStaleSec?: number,
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
    let settled = false;

    const cleanup = () => {
      if (progressTimer) clearTimeout(progressTimer);
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
        fail(new Error(heartbeatProgressStaleErrorText(staleSec)));
      }, staleSec * 1000);
    };

    const onAbort = () => {
      session.abort();
      fail(heartbeatAbortedError());
    };

    abortSignal?.addEventListener('abort', onAbort, { once: true });
    resetProgressWatchdog();

    unsub = session.subscribe((event) => {
      onEvent(event);

      if (isHarnessProgressEvent(event)) {
        resetProgressWatchdog();
      }

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
