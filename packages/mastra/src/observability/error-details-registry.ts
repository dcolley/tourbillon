/**
 * Registry for storing AI_APICallError details that Mastra doesn't copy into span.errorInfo.
 * Supports lookup by runId (for exporter at SPAN_ENDED) and requestKey (for transfer/debugging).
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
 */
export function storeApiErrorDetails(runId: string, details: Omit<ApiErrorDetails, 'capturedAtMs'>): void {
  const entry = {
    ...details,
    capturedAtMs: Date.now(),
  };
  registryByRunId.set(runId, entry);
  
  if (details.firstFrameRequestKey) {
    registryByRequestKey.set(details.firstFrameRequestKey, entry);
  }
}

/**
 * Store AI_APICallError details by fetch requestKey.
 * If runId is provided, also stores by runId for direct exporter lookup.
 */
export function storeApiErrorDetailsByRequestKey(
  requestKey: string, 
  details: Omit<ApiErrorDetails, 'capturedAtMs' | 'firstFrameRequestKey'>,
  runId?: string
): void {
  const entry = {
    ...details,
    firstFrameRequestKey: requestKey,
    capturedAtMs: Date.now(),
  };
  registryByRequestKey.set(requestKey, entry);
  
  // If runId is available, also store by runId for direct exporter access
  if (runId) {
    registryByRunId.set(runId, entry);
  }
}

/**
 * Retrieve and remove stored API error details for a heartbeat run.
 */
export function consumeApiErrorDetails(runId: string): ApiErrorDetails | undefined {
  const details = registryByRunId.get(runId);
  if (!details) return undefined;

  registryByRunId.delete(runId);
  
  if (details.firstFrameRequestKey) {
    registryByRequestKey.delete(details.firstFrameRequestKey);
  }

  if (Date.now() - details.capturedAtMs > MAX_AGE_MS) {
    return undefined;
  }

  return details;
}

/**
 * Retrieve and remove stored API error details by fetch requestKey.
 */
export function consumeApiErrorDetailsByRequestKey(requestKey: string): ApiErrorDetails | undefined {
  const details = registryByRequestKey.get(requestKey);
  if (!details) return undefined;

  registryByRequestKey.delete(requestKey);

  if (Date.now() - details.capturedAtMs > MAX_AGE_MS) {
    return undefined;
  }

  return details;
}

/**
 * Peek at stored API error details without removing them.
 */
export function peekApiErrorDetails(runId: string): ApiErrorDetails | undefined {
  return registryByRunId.get(runId);
}

/**
 * Peek at stored API error details by requestKey without removing them.
 */
export function peekApiErrorDetailsByRequestKey(requestKey: string): ApiErrorDetails | undefined {
  return registryByRequestKey.get(requestKey);
}

/**
 * Clear all stored error details.
 */
export function clearAllApiErrorDetails(): void {
  registryByRunId.clear();
  registryByRequestKey.clear();
}
