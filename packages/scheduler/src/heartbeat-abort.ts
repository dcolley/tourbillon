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

/**
 * Extract enriched error text from AI_APICallError when available.
 */
function extractApiCallErrorText(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  
  const apiError = err as Error & {
    statusCode?: number;
    url?: string;
    responseBody?: string;
    data?: unknown;
  };
  
  // Check if this looks like an AI_APICallError
  if (apiError.statusCode === undefined && apiError.url === undefined && apiError.responseBody === undefined) {
    return undefined;
  }
  
  const parts: string[] = [];
  
  // Try to extract structured error message from data or responseBody
  if (apiError.data && typeof apiError.data === 'object') {
    const data = apiError.data as Record<string, unknown>;
    const error = data.error as Record<string, unknown> | undefined;
    if (error && typeof error === 'object') {
      const msg = error.message;
      if (typeof msg === 'string' && msg.trim()) {
        parts.push(msg.trim());
      }
    }
  } else if (apiError.responseBody && typeof apiError.responseBody === 'string') {
    const trimmed = apiError.responseBody.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const error = parsed.error as Record<string, unknown> | undefined;
        if (error && typeof error === 'object') {
          const msg = error.message;
          if (typeof msg === 'string' && msg.trim()) {
            parts.push(msg.trim());
          }
        }
      } catch {
        // Not valid JSON, use raw message
      }
    }
  }
  
  // Fallback to original message if no structured error found
  if (parts.length === 0) {
    parts.push(err.message);
  }
  
  if (apiError.statusCode !== undefined) {
    parts.push(`HTTP ${apiError.statusCode}`);
  }
  
  if (apiError.url && typeof apiError.url === 'string') {
    try {
      const parsed = new URL(apiError.url);
      parts.push(`at ${parsed.host}${parsed.pathname}`);
    } catch {
      // Invalid URL, skip
    }
  }
  
  // Cap responseBody excerpt
  if (apiError.responseBody && typeof apiError.responseBody === 'string' && parts.length <= 2) {
    const trimmed = apiError.responseBody.trim();
    const excerpt = trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
    parts.push(`Response: ${excerpt}`);
  }
  
  return parts.join(' | ');
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
  
  // Check for wall-clock timeout in abort reason
  if (abortReason instanceof Error && abortReason.message.includes('wall-clock timeout')) {
    return abortReason.message;
  }
  
  // Check for timeout message before abort-like errors (timeout is in isAbortLikeError)
  if (err instanceof Error && err.message === 'Heartbeat timeout') {
    return err.message;
  }
  
  // Check for wall-clock timeout in error itself
  if (err instanceof Error && err.message.includes('wall-clock timeout')) {
    return err.message;
  }
  
  if (aborted || isAbortLikeError(err)) {
    const { staleSec } = resolveHeartbeatLivenessConfig();
    return heartbeatStaleErrorText(staleSec);
  }
  
  // Try to extract enriched AI_APICallError details
  const apiErrorText = extractApiCallErrorText(err);
  if (apiErrorText) {
    // Try to append first frame capture if available
    const firstFrame = tryGetFirstFrameCapture(err);
    if (firstFrame) {
      return `${apiErrorText} | ${firstFrame}`;
    }
    return apiErrorText;
  }
  
  const baseMessage = err instanceof Error ? err.message : String(err);
  
  // Try to append first frame capture if this looks like a stream failure
  if (baseMessage.includes('stream') || baseMessage.includes('output')) {
    const firstFrame = tryGetFirstFrameCapture(err);
    if (firstFrame) {
      return `${baseMessage} | ${firstFrame}`;
    }
  }
  
  return baseMessage;
}

/**
 * Extract first frame capture using request key from error object.
 * Returns undefined if the module is not available, no key, or no capture exists.
 */
function tryGetFirstFrameCapture(err: unknown): string | undefined {
  try {
    // Extract request key from error object (attached by createFirstFrameCaptureFetch)
    let requestKey: string | undefined;
    if (err && typeof err === 'object' && '__firstFrameRequestKey' in err) {
      const key = (err as { __firstFrameRequestKey?: unknown }).__firstFrameRequestKey;
      requestKey = typeof key === 'string' ? key : undefined;
    }
    
    if (!requestKey) {
      return undefined;
    }
    
    // Dynamic import to avoid circular dependencies
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getFirstFrameCapture, formatFirstFrameCapture } = require('@tourbillon/mastra/first-frame-capture') as typeof import('@tourbillon/mastra/first-frame-capture');
    const capture = getFirstFrameCapture(requestKey);
    return capture ? formatFirstFrameCapture(capture) : undefined;
  } catch {
    return undefined;
  }
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
