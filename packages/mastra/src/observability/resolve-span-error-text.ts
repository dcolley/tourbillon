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
 */
export function resolveSpanErrorText(span: AnyExportedSpan): string | undefined {
  const errorInfo = span.errorInfo as
    | { message?: string; name?: string; code?: string | number; statusCode?: number; url?: string; responseBody?: string; data?: unknown }
    | undefined;

  if (!errorInfo) return undefined;

  // Try AI_APICallError enriched extraction first
  if (errorInfo.statusCode !== undefined || errorInfo.url !== undefined || errorInfo.responseBody !== undefined) {
    const enriched = buildApiCallErrorText(errorInfo as Record<string, unknown>);
    if (enriched) return enriched;
  }

  const message = asNonEmptyString(errorInfo.message);
  if (message === 'terminated') return TERMINATED_MESSAGE;
  if (message) return message;

  const name = asNonEmptyString(errorInfo.name);
  if (name) return name;

  if (errorInfo.code != null && String(errorInfo.code).trim()) {
    return String(errorInfo.code);
  }

  const finishReason = finishReasonFromSpan(span);
  if (finishReason) return messageFromFinishReason(finishReason);

  return 'Unknown error (no message from runtime)';
}
