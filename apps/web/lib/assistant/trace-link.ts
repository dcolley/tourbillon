/**
 * OBS-1: client-safe helpers for "Trace" links on assistant messages. No env access here: the base
 * URL comes from the server (PHOENIX_UI_BASE_URL via `phoenixUiBaseUrl()`), and the link is hidden
 * whenever the base URL or the trace id is missing or malformed.
 *
 * Phoenix resolves an OpenTelemetry trace id with `<base>/redirects/traces/<traceId>`.
 */
import { AGUI_CUSTOM } from '@/lib/agui/session-events';

/** OTEL / Mastra trace ids: 1–32 hex characters. */
const TRACE_ID_RE = /^[0-9a-f]{1,32}$/i;

export function isTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID_RE.test(value);
}

/** `<base>/redirects/traces/<traceId>`, or undefined when either part is missing or unsafe. */
export function buildTraceUrl(baseUrl: string | null | undefined, traceId: string | null | undefined): string | undefined {
  if (!baseUrl || !isTraceId(traceId)) return undefined;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username || url.password) return undefined;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}/redirects/traces/${traceId.toLowerCase()}`;
}

/** Trace id saved on a thread message (`content.metadata.traceId`, stamped by Mastra on traced runs). */
export function traceIdFromMessage(message: { content?: unknown } | null | undefined): string | undefined {
  const content = message?.content as { metadata?: Record<string, unknown> } | undefined;
  const value = content && typeof content === 'object' ? content.metadata?.traceId : undefined;
  return isTraceId(value) ? value : undefined;
}

export interface AguiRunTrace {
  traceId: string;
  /** Present only when the server has a Phoenix UI base URL configured. */
  traceUrl?: string;
}

function pickTrace(value: unknown): AguiRunTrace | undefined {
  const v = value as { traceId?: unknown; traceUrl?: unknown } | null | undefined;
  if (!v || !isTraceId(v.traceId)) return undefined;
  return typeof v.traceUrl === 'string' && v.traceUrl.length > 0
    ? { traceId: v.traceId, traceUrl: v.traceUrl }
    : { traceId: v.traceId };
}

/**
 * Trace of an AG-UI run from its events: the `tourbillon.trace` CUSTOM event (sent right after
 * RUN_STARTED) or the RUN_FINISHED `result` (`{ reason, traceId, traceUrl? }`).
 */
export function traceFromAguiEvent(event: { type?: unknown; name?: unknown; value?: unknown; result?: unknown }): AguiRunTrace | undefined {
  if (event.type === 'CUSTOM' && event.name === AGUI_CUSTOM.trace) return pickTrace(event.value);
  if (event.type === 'RUN_FINISHED') return pickTrace(event.result);
  return undefined;
}
