import { heartbeatStaleErrorText, resolveHeartbeatLivenessConfig } from '@tourbillon/shared';

export const HEARTBEAT_ABORTED = 'Heartbeat aborted';
export const OPERATOR_FORCE_KILL_REASON = 'Force-killed by operator';

export function heartbeatAbortedError(): Error {
  return new Error(HEARTBEAT_ABORTED);
}

export function operatorForceKillError(): Error {
  return new Error(OPERATOR_FORCE_KILL_REASON);
}

export function isAbortLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg === 'terminated' ||
    msg === HEARTBEAT_ABORTED.toLowerCase() ||
    msg === 'heartbeat timeout' ||
    msg === 'the operation was aborted' ||
    msg.includes('aborted')
  );
}

export function resolveHeartbeatFailureError(
  err: unknown,
  aborted: boolean,
  abortReason?: unknown,
): string {
  // Check for operator force-kill first
  if (
    abortReason instanceof Error &&
    abortReason.message === OPERATOR_FORCE_KILL_REASON
  ) {
    return OPERATOR_FORCE_KILL_REASON;
  }
  
  // Check for timeout message before abort-like errors (timeout is in isAbortLikeError)
  if (err instanceof Error && err.message === 'Heartbeat timeout') {
    return err.message;
  }
  
  if (aborted || isAbortLikeError(err)) {
    const { staleSec } = resolveHeartbeatLivenessConfig();
    return heartbeatStaleErrorText(staleSec);
  }
  
  return err instanceof Error ? err.message : String(err);
}

export function abortRejectedPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(heartbeatAbortedError());
  }
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(heartbeatAbortedError()), { once: true });
  });
}

/** Race work against abort so the wake fails when the signal fires or fetch is cut off. */
export async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([promise, abortRejectedPromise(signal)]);
}
