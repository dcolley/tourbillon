import type { AnyExportedSpan } from '@mastra/core/observability';

const TERMINATED_MESSAGE =
  'Run terminated (abort, worker shutdown, or stall recovery)';
const MAX_RESPONSE_BODY_CHARS = 2000;

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function finishReasonFromSpan(span: AnyExportedSpan): string | undefined {
  const attrs = span.attributes as Record<string, unknown> | undefined;
  const fromAttrs = asNonEmptyString(attrs?.finishReason);
  if (fromAttrs) return fromAttrs;

  if (typeof span.output === 'string') {
    return asNonEmptyString(span.output);
  }

  if (span.output && typeof span.output === 'object' && !Array.isArray(span.output)) {
    return asNonEmptyString((span.output as Record<string, unknown>).finishReason);
  }

  return undefined;
}

function messageFromFinishReason(finishReason: string): string {
  if (finishReason === 'terminated') return TERMINATED_MESSAGE;
  return `Run failed: ${finishReason}`;
}

/**
 * Extract host and path from a URL, omitting query params and protocol.
 */
function extractUrlHostPath(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url.trim()) return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * Extract structured error message from AI_APICallError responseBody or data.
 */
function extractApiErrorMessage(errorInfo: Record<string, unknown>): string | undefined {
  // Try data.error.message first (common pattern)
  const data = errorInfo.data as Record<string, unknown> | null | undefined;
  if (data && typeof data === 'object') {
    const error = data.error as Record<string, unknown> | undefined;
    if (error && typeof error === 'object') {
      const msg = asNonEmptyString(error.message);
      if (msg) return msg;
    }
  }

  // Try responseBody as JSON
  const responseBody = errorInfo.responseBody;
  if (typeof responseBody === 'string' && responseBody.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(responseBody) as Record<string, unknown>;
      const error = parsed.error as Record<string, unknown> | undefined;
      if (error && typeof error === 'object') {
        const msg = asNonEmptyString(error.message);
        if (msg) return msg;
      }
    } catch {
      // Not valid JSON, fall through
    }
  }

  return undefined;
}

/**
 * Build enriched error text from AI_APICallError with statusCode, URL, and response excerpt.
 */
function buildApiCallErrorText(errorInfo: Record<string, unknown>): string | undefined {
  const fallbackMessage = asNonEmptyString(errorInfo.message);
  const statusCode = typeof errorInfo.statusCode === 'number' ? errorInfo.statusCode : undefined;
  const urlHostPath = extractUrlHostPath(errorInfo.url);
  
  // Try to extract a better error message from data or responseBody
  const apiErrorMsg = extractApiErrorMessage(errorInfo);
  
  // Cap responseBody for display
  let responseExcerpt: string | undefined;
  const responseBody = errorInfo.responseBody;
  if (typeof responseBody === 'string' && responseBody.trim()) {
    const trimmed = responseBody.trim();
    responseExcerpt = trimmed.length > MAX_RESPONSE_BODY_CHARS
      ? `${trimmed.slice(0, MAX_RESPONSE_BODY_CHARS)}…`
      : trimmed;
  }

  // Build enriched message
  const parts: string[] = [];
  if (apiErrorMsg) {
    parts.push(apiErrorMsg);
  } else if (fallbackMessage) {
    parts.push(fallbackMessage);
  }
  
  if (statusCode !== undefined) {
    parts.push(`HTTP ${statusCode}`);
  }
  
  if (urlHostPath) {
    parts.push(`at ${urlHostPath}`);
  }

  if (responseExcerpt && !apiErrorMsg) {
    // Only include response excerpt if we didn't extract a structured message
    parts.push(`Response: ${responseExcerpt}`);
  }

  return parts.length > 0 ? parts.join(' | ') : undefined;
}

/**
 * Build a human-readable error string from a Mastra exported span.
 * Mastra often sets errorInfo without message when runs abort with finishReason "terminated".
 * For AI_APICallError, includes statusCode, URL host+path, and capped responseBody.
 * When available, includes first stream frame kind for debugging SDK vs provider issues.
 */
export function resolveSpanErrorText(span: AnyExportedSpan): string | undefined {
  const errorInfo = span.errorInfo as
    | { message?: string; name?: string; code?: string | number; statusCode?: number; url?: string; responseBody?: string; data?: unknown }
    | undefined;

  if (!errorInfo) return undefined;
  
  // Extract AI_APICallError fields from requestContext
  const ctx = span.requestContext;
  const contextStatusCode = extractContextNumber(ctx, '__errorStatusCode');
  const contextUrl = extractContextString(ctx, '__errorUrl');
  const contextResponseBody = extractContextString(ctx, '__errorResponseBody');
  const contextData = extractContextRaw(ctx, '__errorData');
  const requestKey = extractContextString(ctx, '__firstFrameRequestKey');

  // Try AI_APICallError enriched extraction first (context overrides errorInfo)
  if (contextStatusCode !== undefined || contextUrl !== undefined || contextResponseBody !== undefined ||
      errorInfo.statusCode !== undefined || errorInfo.url !== undefined || errorInfo.responseBody !== undefined) {
    
    // Build enriched error object with context values taking precedence
    const enrichedError: Record<string, unknown> = {
      ...errorInfo,
      statusCode: contextStatusCode ?? errorInfo.statusCode,
      url: contextUrl ?? errorInfo.url,
      responseBody: contextResponseBody ?? errorInfo.responseBody,
      data: contextData ?? errorInfo.data,
    };
    
    const enriched = buildApiCallErrorText(enrichedError);
    if (enriched) {
      // Try to append first frame capture if available
      const firstFrame = tryGetFirstFrameCapture(requestKey);
      if (firstFrame) {
        return `${enriched} | ${firstFrame}`;
      }
      return enriched;
    }
  }

  const message = asNonEmptyString(errorInfo.message);
  if (message === 'terminated') return TERMINATED_MESSAGE;
  if (message) {
    // Try to append first frame capture if this looks like a stream failure
    if (message.includes('stream') || message.includes('output')) {
      const firstFrame = tryGetFirstFrameCapture(requestKey);
      if (firstFrame) {
        return `${message} | ${firstFrame}`;
      }
    }
    return message;
  }

  const name = asNonEmptyString(errorInfo.name);
  if (name) return name;

  if (errorInfo.code != null && String(errorInfo.code).trim()) {
    return String(errorInfo.code);
  }

  const finishReason = finishReasonFromSpan(span);
  if (finishReason) return messageFromFinishReason(finishReason);

  return 'Unknown error (no message from runtime)';
}

/**
 * Extract string value from requestContext.
 */
function extractContextString(ctx: unknown, key: string): string | undefined {
  if (!ctx || typeof ctx !== 'object') return undefined;
  
  if ('get' in ctx && typeof (ctx as { get: unknown }).get === 'function') {
    const value = (ctx as { get: (k: string) => unknown }).get(key);
    return typeof value === 'string' ? value : undefined;
  }
  
  const value = (ctx as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Extract number value from requestContext.
 */
function extractContextNumber(ctx: unknown, key: string): number | undefined {
  if (!ctx || typeof ctx !== 'object') return undefined;
  
  if ('get' in ctx && typeof (ctx as { get: unknown }).get === 'function') {
    const value = (ctx as { get: (k: string) => unknown }).get(key);
    return typeof value === 'number' ? value : undefined;
  }
  
  const value = (ctx as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Extract raw value from requestContext.
 */
function extractContextRaw(ctx: unknown, key: string): unknown {
  if (!ctx || typeof ctx !== 'object') return undefined;
  
  if ('get' in ctx && typeof (ctx as { get: unknown }).get === 'function') {
    return (ctx as { get: (k: string) => unknown }).get(key);
  }
  
  return (ctx as Record<string, unknown>)[key];
}

/**
 * Extract request key from span's requestContext (deprecated in favor of extractContextString).
 */
function extractRequestKey(span: AnyExportedSpan): string | undefined {
  return extractContextString(span.requestContext, '__firstFrameRequestKey');
}

/**
 * Try to get first frame capture using request key.
 * Returns undefined if the module is not available, no key, or no capture exists.
 */
function tryGetFirstFrameCapture(requestKey: string | undefined): string | undefined {
  if (!requestKey) return undefined;
  
  try {
    // Dynamic import to avoid circular dependencies
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getFirstFrameCapture, formatFirstFrameCapture } = require('../first-frame-capture') as typeof import('../first-frame-capture');
    const capture = getFirstFrameCapture(requestKey);
    return capture ? formatFirstFrameCapture(capture) : undefined;
  } catch {
    return undefined;
  }
}
