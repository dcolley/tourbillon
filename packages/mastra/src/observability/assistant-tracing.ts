/**
 * OBS-1: one trace per assistant-view (AG-UI) run, so every assistant turn can link to its trace.
 *
 * `buildAssistantTracingOptions` is the `tracingOptions` the AG-UI route hands to
 * `session.sendMessage` (same shape as the heartbeat options): a caller-chosen hex trace id plus
 * root-span metadata and tags (companyId, agentId, threadId, view=assistant, provider, model).
 * Model, tool and memory spans of the turn are children of that root, and every span still goes
 * through the existing span output processors (known-secret scrub, then SensitiveDataFilter)
 * before any exporter, so nothing here bypasses redaction.
 *
 * The trace id is stored on the message by Mastra itself: a traced run stamps
 * `content.metadata.traceId` on the assistant message it saves (see `messageTraceId`).
 */
import { isMastraTracingEnabled } from '@tourbillon/shared';
import { createHeartbeatTraceId } from './heartbeat-tracing-options';

/** `view` attribute for assistant-view turns (Control Pane chat and heartbeats do not set it). */
export const ASSISTANT_TRACE_VIEW = 'assistant';

/** Message metadata key holding the turn's trace id. */
export const ASSISTANT_MESSAGE_TRACE_KEY = 'traceId';

/** OTEL / Mastra trace ids: 1–32 hex characters. */
const TRACE_ID_RE = /^[0-9a-f]{1,32}$/i;

export function isTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID_RE.test(value);
}

export interface AssistantTracingInput {
  companyId: string;
  agentId: string;
  agentUrlKey?: string | null;
  /** Mastra memory thread id (the AG-UI threadId). */
  threadId: string;
  /** Configured provider id for the agent (PRV-1 may fall back at run time; model spans show the effective one). */
  provider?: string | null;
  /** Model id the turn was started with. */
  model?: string | null;
  /** AG-UI run id (client-chosen); kept so a trace can be matched to the client run. */
  aguiRunId?: string | null;
  /** Reuse this trace id (hex). A new one is created when omitted. */
  traceId?: string;
}

export interface AssistantTracingOptions {
  traceId: string;
  metadata: Record<string, string>;
  tags: string[];
  requestContextKeys: string[];
}

function clean(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * `tracingOptions` for one assistant run, or `undefined` when no span exporter is configured
 * (then there is no trace to link to). `enabled` overrides the env check (tests).
 */
export function buildAssistantTracingOptions(
  input: AssistantTracingInput,
  options: { enabled?: boolean } = {},
): AssistantTracingOptions | undefined {
  const enabled = options.enabled ?? isMastraTracingEnabled();
  if (!enabled) return undefined;
  if (input.traceId !== undefined && !isTraceId(input.traceId)) {
    throw new Error('traceId must be 1-32 hexadecimal characters');
  }
  const traceId = input.traceId ?? createHeartbeatTraceId();

  const metadata: Record<string, string> = {
    companyId: input.companyId,
    agentId: input.agentId,
    threadId: input.threadId,
    view: ASSISTANT_TRACE_VIEW,
  };
  const optional: Array<[string, string | undefined]> = [
    ['agentUrlKey', clean(input.agentUrlKey)],
    ['provider', clean(input.provider)],
    ['model', clean(input.model)],
    ['aguiRunId', clean(input.aguiRunId)],
  ];
  for (const [key, value] of optional) if (value !== undefined) metadata[key] = value;

  return {
    traceId,
    metadata,
    tags: [
      `company:${input.companyId}`,
      `agent:${clean(input.agentUrlKey) ?? input.agentId}`,
      `view:${ASSISTANT_TRACE_VIEW}`,
    ],
    requestContextKeys: ['runId', 'agentId', 'companyId'],
  };
}

/**
 * Trace id stored on a saved message. Mastra stamps `content.metadata.traceId` on the assistant
 * message of a traced run (the run's trace id, i.e. the one passed in `tracingOptions`), so the
 * thread messages API already returns it on reload.
 */
export function messageTraceId(message: { content?: unknown }): string | undefined {
  const content = message.content as { metadata?: Record<string, unknown> } | undefined;
  const value = content && typeof content === 'object' ? content.metadata?.[ASSISTANT_MESSAGE_TRACE_KEY] : undefined;
  return isTraceId(value) ? value : undefined;
}
