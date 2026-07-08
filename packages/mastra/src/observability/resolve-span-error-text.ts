import type { AnyExportedSpan } from '@mastra/core/observability';

const TERMINATED_MESSAGE =
  'Run terminated (abort, worker shutdown, or stall recovery)';

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
 * Build a human-readable error string from a Mastra exported span.
 * Mastra often sets errorInfo without message when runs abort with finishReason "terminated".
 */
export function resolveSpanErrorText(span: AnyExportedSpan): string | undefined {
  const errorInfo = span.errorInfo as
    | { message?: string; name?: string; code?: string | number }
    | undefined;

  if (!errorInfo) return undefined;

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
