/**
 * Registry for storing AI_APICallError details that Mastra doesn't copy into span.errorInfo.
 * Keyed by heartbeat runId so the exporter can enrich errorInfo before mapping.
 */

export interface ApiErrorDetails {
  statusCode?: number;
  url?: string;
  responseBody?: string;
  data?: unknown;
  firstFrameRequestKey?: string;
  capturedAtMs: number;
}

const registry = new Map<string, ApiErrorDetails>();

const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Store AI_APICallError details for a heartbeat run.
 * Call this immediately after catching an AI_APICallError.
 */
export function storeApiErrorDetails(runId: string, details: Omit<ApiErrorDetails, 'capturedAtMs'>): void {
  registry.set(runId, {
    ...details,
    capturedAtMs: Date.now(),
  });
}

/**
 * Retrieve and remove stored API error details for a heartbeat run.
 * Returns undefined if not found or expired.
 */
export function consumeApiErrorDetails(runId: string): ApiErrorDetails | undefined {
  const details = registry.get(runId);
  if (!details) return undefined;

  registry.delete(runId);

  // Reject stale entries (shouldn't happen but fail safe)
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
  return registry.get(runId);
}

/**
 * Clear all stored error details.
 * Used for testing.
 */
export function clearAllApiErrorDetails(): void {
  registry.clear();
}
