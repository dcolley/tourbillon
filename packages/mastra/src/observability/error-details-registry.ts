/**
 * Registry for storing AI_APICallError details that Mastra doesn't copy into span.errorInfo.
 * Supports lookup by both heartbeat runId and fetch requestKey.
 */

export interface ApiErrorDetails {
  statusCode?: number;
  url?: string;
  responseBody?: string;
  data?: unknown;
  firstFrameRequestKey?: string;
  capturedAtMs: number;
}

const registryByRunId = new Map<string, ApiErrorDetails>();
const registryByRequestKey = new Map<string, ApiErrorDetails>();

const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Store AI_APICallError details for a heartbeat run.
 * Call this from the wake-runner catch block if you have the runId.
 */
export function storeApiErrorDetails(runId: string, details: Omit<ApiErrorDetails, 'capturedAtMs'>): void {
  const entry = {
    ...details,
    capturedAtMs: Date.now(),
  };
  registryByRunId.set(runId, entry);
  
  // Also store by requestKey if present for cross-referencing
  if (details.firstFrameRequestKey) {
    registryByRequestKey.set(details.firstFrameRequestKey, entry);
  }
}

/**
 * Store AI_APICallError details by fetch requestKey.
 * Call this from the fetch wrapper before the error bubbles to Mastra.
 */
export function storeApiErrorDetailsByRequestKey(requestKey: string, details: Omit<ApiErrorDetails, 'capturedAtMs' | 'firstFrameRequestKey'>): void {
  const entry = {
    ...details,
    firstFrameRequestKey: requestKey,
    capturedAtMs: Date.now(),
  };
  registryByRequestKey.set(requestKey, entry);
}

/**
 * Retrieve and remove stored API error details for a heartbeat run.
 * Returns undefined if not found or expired.
 */
export function consumeApiErrorDetails(runId: string): ApiErrorDetails | undefined {
  const details = registryByRunId.get(runId);
  if (!details) return undefined;

  registryByRunId.delete(runId);
  
  // Also clean up requestKey entry if present
  if (details.firstFrameRequestKey) {
    registryByRequestKey.delete(details.firstFrameRequestKey);
  }

  // Reject stale entries
  if (Date.now() - details.capturedAtMs > MAX_AGE_MS) {
    return undefined;
  }

  return details;
}

/**
 * Retrieve and remove stored API error details by fetch requestKey.
 * Returns undefined if not found or expired.
 */
export function consumeApiErrorDetailsByRequestKey(requestKey: string): ApiErrorDetails | undefined {
  const details = registryByRequestKey.get(requestKey);
  if (!details) return undefined;

  registryByRequestKey.delete(requestKey);

  // Reject stale entries
  if (Date.now() - details.capturedAtMs > MAX_AGE_MS) {
    return undefined;
  }

  return details;
}

/**
 * Peek at stored API error details without removing them.
 * Used for testing.
 */
export function peekApiErrorDetails(runId: string): ApiErrorDetails | undefined {
  return registryByRunId.get(runId);
}

/**
 * Peek at stored API error details by requestKey without removing them.
 * Used for testing.
 */
export function peekApiErrorDetailsByRequestKey(requestKey: string): ApiErrorDetails | undefined {
  return registryByRequestKey.get(requestKey);
}

/**
 * Clear all stored error details.
 * Used for testing.
 */
export function clearAllApiErrorDetails(): void {
  registryByRunId.clear();
  registryByRequestKey.clear();
}
