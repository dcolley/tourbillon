import { SpanType, TracingEventType, type AnyExportedSpan } from '@mastra/core/observability';
import type { NewAgentObservabilityEvent } from '@tourbillon/db';
import {
  observabilityMaxPayloadBytes,
  observabilityPreviewChars,
  type ObservabilityEventStatus,
  type ObservabilityEventType,
} from '@tourbillon/shared';
import { randomUUID } from 'crypto';

const SPAN_TYPE_MAP: Partial<Record<SpanType, ObservabilityEventType>> = {
  [SpanType.AGENT_RUN]: 'agent_run',
  [SpanType.MODEL_GENERATION]: 'model_generation',
  [SpanType.MODEL_STEP]: 'model_step',
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
  };
}

function mapEventType(span: AnyExportedSpan): ObservabilityEventType {
  return SPAN_TYPE_MAP[span.type as SpanType] ?? 'generic';
}

function mapStatus(span: AnyExportedSpan): ObservabilityEventStatus {
  return span.errorInfo ? 'error' : 'ok';
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
    status: mapStatus(span),
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
        tags: span.tags,
        entityType: span.entityType,
        entityId: span.entityId,
        entityName: span.entityName,
      },
      maxPayloadBytes
    ),
    errorText: span.errorInfo?.message,
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
