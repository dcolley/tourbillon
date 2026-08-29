import { SpanType, TracingEventType, type AnyExportedSpan } from '@mastra/core/observability';
import type { NewAgentObservabilityEvent } from '@tourbillon/db';
import {
  observabilityMaxPayloadBytes,
  observabilityPreviewChars,
  type ObservabilityEventStatus,
  type ObservabilityEventType,
  isSystemMessageTripwire,
  extractTripwireTokenCounts,
  formatSystemMessageTripwireError,
} from '@tourbillon/shared';
import { randomUUID } from 'crypto';
import { resolveSpanErrorText } from './resolve-span-error-text';

const SPAN_TYPE_MAP: Partial<Record<SpanType, ObservabilityEventType>> = {
  [SpanType.AGENT_RUN]: 'agent_run',
  [SpanType.MODEL_GENERATION]: 'model_generation',
  [SpanType.MODEL_STEP]: 'model_step',
  [SpanType.MODEL_INFERENCE]: 'model_inference',
  [SpanType.MODEL_CHUNK]: 'model_chunk',
  [SpanType.TOOL_CALL]: 'tool_call',
  [SpanType.MCP_TOOL_CALL]: 'mcp_tool_call',
  [SpanType.CLIENT_TOOL_CALL]: 'tool_call',
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function previewValue(value: unknown, maxChars: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}

function capPayload(value: unknown, maxBytes: number): Record<string, unknown> {
  const base: Record<string, unknown> =
    value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : { value };

  let serialized = JSON.stringify(base);
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) {
    return base;
  }

  return {
    truncated: true,
    preview: serialized.slice(0, Math.min(maxBytes, 4000)),
  };
}

function readContextValue(ctx: unknown, key: string): string | undefined {
  if (
    ctx &&
    typeof ctx === 'object' &&
    'get' in ctx &&
    typeof (ctx as { get: unknown }).get === 'function'
  ) {
    return asString((ctx as { get: (k: string) => unknown }).get(key));
  }
  if (ctx && typeof ctx === 'object') {
    return asString((ctx as Record<string, unknown>)[key]);
  }
  return undefined;
}

function extractContext(span: AnyExportedSpan): {
  companyId?: string;
  heartbeatRunId?: string;
  jobId?: string;
  agentId?: string;
  issueId?: string;
  projectId?: string;
  goalId?: string;
  errorStatusCode?: number;
  errorUrl?: string;
  errorResponseBody?: string;
  errorData?: unknown;
  firstFrameRequestKey?: string;
} {
  const ctx = span.requestContext;
  const meta = (span.metadata ?? {}) as Record<string, unknown>;

  return {
    companyId: readContextValue(ctx, 'companyId') ?? asString(meta.companyId),
    heartbeatRunId:
      readContextValue(ctx, 'runId') ??
      asString(meta.heartbeatRunId) ??
      asString(meta.runId),
    jobId: readContextValue(ctx, 'jobId') ?? asString(meta.jobId),
    agentId:
      readContextValue(ctx, 'agentId') ??
      asString(meta.agentId) ??
      asString(span.entityId),
    issueId:
      readContextValue(ctx, 'taskId') ??
      asString(meta.issueId) ??
      asString(meta.taskId),
    projectId: readContextValue(ctx, 'projectId') ?? asString(meta.projectId),
    goalId: readContextValue(ctx, 'goalId') ?? asString(meta.goalId),
    // Extract AI_APICallError fields from runtime context
    errorStatusCode: typeof ctx === 'object' && ctx && '__errorStatusCode' in ctx 
      ? (ctx as { __errorStatusCode?: number }).__errorStatusCode 
      : undefined,
    errorUrl: readContextValue(ctx, '__errorUrl'),
    errorResponseBody: readContextValue(ctx, '__errorResponseBody'),
    errorData: ctx && typeof ctx === 'object' && '__errorData' in ctx 
      ? (ctx as { __errorData?: unknown }).__errorData 
      : undefined,
    firstFrameRequestKey: readContextValue(ctx, '__firstFrameRequestKey'),
  };
}

function mapEventType(span: AnyExportedSpan): ObservabilityEventType {
  return SPAN_TYPE_MAP[span.type as SpanType] ?? 'generic';
}

function mapStatus(span: AnyExportedSpan): ObservabilityEventStatus {
  if (span.errorInfo) return 'error';
  
  // Check for system-message tripwire in output
  if (span.output && isSystemMessageTripwire(span.output)) {
    return 'error';
  }
  
  return 'ok';
}

function durationMs(span: AnyExportedSpan): number | undefined {
  if (!span.startTime || !span.endTime) return undefined;
  const ms = span.endTime.getTime() - span.startTime.getTime();
  return ms >= 0 ? ms : undefined;
}

function tokenUsage(span: AnyExportedSpan): { input?: number; output?: number } {
  const usage = (span.attributes as { usage?: Record<string, number> } | undefined)?.usage;
  if (!usage) return {};
  const input = usage.promptTokens ?? usage.inputTokens;
  const output = usage.completionTokens ?? usage.outputTokens;
  return {
    input: typeof input === 'number' ? input : undefined,
    output: typeof output === 'number' ? output : undefined,
  };
}

/**
 * Enrich errorInfo with full AI_APICallError fields for diagnostics.
 * Ensures statusCode, url, responseBody, and data are preserved in the payload.
 * Mastra may only copy message/name/stack; we extract the rest from runtime context.
 */
function enrichErrorInfo(errorInfo: unknown, context: ReturnType<typeof extractContext>): unknown {
  if (!errorInfo || typeof errorInfo !== 'object') return errorInfo;
  
  const err = errorInfo as Record<string, unknown>;
  
  // Create enriched object with all available fields
  const enriched: Record<string, unknown> = { ...err };
  
  // First, copy AI_APICallError fields from runtime context (highest priority)
  if (context.errorStatusCode !== undefined) {
    enriched.statusCode = context.errorStatusCode;
  }
  if (context.errorUrl !== undefined) {
    enriched.url = context.errorUrl;
  }
  if (context.errorResponseBody !== undefined) {
    enriched.responseBody = context.errorResponseBody;
  }
  if (context.errorData !== undefined) {
    enriched.data = context.errorData;
  }
  
  // Then ensure AI_APICallError fields are preserved if present on errorInfo itself (backward compat)
  const apiErrorFields = ['statusCode', 'url', 'responseBody', 'responseHeaders', 'data', 'isRetryable', 'cause', 'requestBodyValues'];
  
  let hasApiErrorFields = false;
  for (const field of apiErrorFields) {
    // Only copy from errorInfo if not already set from context
    if (field in err && err[field] !== undefined && enriched[field] === undefined) {
      enriched[field] = err[field];
      hasApiErrorFields = true;
    }
  }
  
  // If this looks like an API error, cap the responseBody to prevent huge payloads
  if (typeof enriched.responseBody === 'string') {
    const body = enriched.responseBody as string;
    if (body.length > 2000) {
      enriched.responseBody = `${body.slice(0, 2000)}… [truncated, full length: ${body.length}]`;
    }
  }
  
  return enriched;
}

export function mapExportedSpanToEvent(span: AnyExportedSpan): NewAgentObservabilityEvent | null {
  const context = extractContext(span);
  if (!context.companyId) return null;

  const previewChars = observabilityPreviewChars();
  const maxPayloadBytes = observabilityMaxPayloadBytes();
  const tokens = tokenUsage(span);
  const attrs = span.attributes as Record<string, unknown> | undefined;
  const toolId =
    asString(attrs?.toolId) ??
    (span.type === SpanType.TOOL_CALL || span.type === SpanType.MCP_TOOL_CALL
      ? span.name
      : undefined);

  const occurredAt = span.endTime ?? span.startTime ?? new Date();
  const eventType = mapEventType(span);
  const name =
    (typeof span.name === 'string' && span.name.trim()) ||
    toolId ||
    eventType;

  const status = mapStatus(span);
  let errorText = resolveSpanErrorText(span);
  
  // For system-message tripwire, enhance error text with token counts
  if (status === 'error' && !span.errorInfo && span.output && isSystemMessageTripwire(span.output)) {
    const counts = extractTripwireTokenCounts(span.output);
    errorText = formatSystemMessageTripwireError(counts.systemTokens, counts.limit);
  }
  
  return {
    id: randomUUID(),
    companyId: context.companyId,
    traceId: span.traceId,
    spanId: span.id,
    parentSpanId: span.parentSpanId,
    heartbeatRunId: context.heartbeatRunId,
    jobId: context.jobId,
    agentId: context.agentId,
    issueId: context.issueId,
    projectId: context.projectId,
    goalId: context.goalId,
    eventType,
    name,
    status,
    model: asString((attrs as { model?: string } | undefined)?.model),
    toolId,
    inputPreview: previewValue(span.input, previewChars),
    outputPreview: previewValue(span.output, previewChars),
    payload: capPayload(
      {
        input: span.input,
        output: span.output,
        attributes: span.attributes,
        metadata: span.metadata,
        errorInfo: enrichErrorInfo(span.errorInfo, context),
        tags: span.tags,
        entityType: span.entityType,
        entityId: span.entityId,
        entityName: span.entityName,
      },
      maxPayloadBytes
    ),
    errorText,
    durationMs: durationMs(span),
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    startedAt: span.startTime,
    occurredAt,
  };
}

export function shouldPersistTracingEvent(eventType: TracingEventType): boolean {
  return eventType === TracingEventType.SPAN_ENDED;
}
