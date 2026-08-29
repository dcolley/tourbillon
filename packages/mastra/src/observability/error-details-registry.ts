/**
 * Registry for storing AI_APICallError details that Mastra doesn't copy into span.errorInfo.
 * Supports lookup by runId, requestKey, and error message for SPAN_ENDED correlation.
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
// For SPAN_ENDED correlation when runId not yet transferred from requestKey
const registryByErrorPattern = new Map<string, ApiErrorDetails>();

const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generate error pattern key for correlation when runId not available.
 * Uses error message substring + company/agent context + recency.
 */
function makeErrorPatternKey(companyId?: string, agentId?: string): string {
  // Use a stable key for SDK stream failures (matches Mastra's message)
  return `stream-fail:${companyId || 'unknown'}:${agentId || 'unknown'}`;
}

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
 * Also stores by error pattern for SPAN_ENDED correlation before wake-runner catch.
 */
export function storeApiErrorDetailsByRequestKey(
  requestKey: string, 
  details: Omit<ApiErrorDetails, 'capturedAtMs' | 'firstFrameRequestKey'>,
  companyId?: string,
  agentId?: string
): void {
  const entry = {
    ...details,
    firstFrameRequestKey: requestKey,
    capturedAtMs: Date.now(),
  };
  registryByRequestKey.set(requestKey, entry);
  
  // Also store by error pattern for exporter to find at SPAN_ENDED
  const patternKey = makeErrorPatternKey(companyId, agentId);
  registryByErrorPattern.set(patternKey, entry);
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
 * Retrieve and remove stored API error details by error pattern.
 * Used by exporter at SPAN_ENDED when runId transfer hasn't happened yet.
 */
export function consumeApiErrorDetailsByPattern(companyId?: string, agentId?: string): ApiErrorDetails | undefined {
  const patternKey = makeErrorPatternKey(companyId, agentId);
  const details = registryByErrorPattern.get(patternKey);
  if (!details) return undefined;

  registryByErrorPattern.delete(patternKey);
  
  // Keep in requestKey registry for potential wake-runner transfer
  // (don't delete from registryByRequestKey yet)

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
  registryByErrorPattern.clear();
}
