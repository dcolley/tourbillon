export const OBSERVABILITY_EVENT_TYPES = [
  'agent_run',
  'model_generation',
  'model_step',
  'model_inference',
  'model_chunk',
  'tool_call',
  'mcp_tool_call',
  'generic',
  // Harness-native event types (real-time streaming)
  'text_delta',
  'tool_call_start',
  'tool_call_result',
  'tool_suspended',
  'tool_approval_required',
  'subagent_spawn',
  'subagent_done',
  'subagent_start',
  'subagent_end',
  'om_observation',
  'om_reflection',
  'agent_done',
  'usage_update',
  'mode_switch',
  'error',
] as const;

export type ObservabilityEventType = (typeof OBSERVABILITY_EVENT_TYPES)[number];

export const OBSERVABILITY_EVENT_STATUSES = ['ok', 'error'] as const;

export type ObservabilityEventStatus = (typeof OBSERVABILITY_EVENT_STATUSES)[number];

export function isObservabilityEnabled(): boolean {
  return process.env.OBSERVABILITY_ENABLED === 'true';
}

/** Export Mastra spans to Arize Phoenix via OTLP (`@mastra/arize`). */
export function isPhoenixCollectorEnabled(): boolean {
  return process.env.PHOENIX_COLLECTOR_ENABLED === 'true';
}

/**
 * True when any Mastra span exporter should run (Postgres UI and/or Phoenix).
 * Use this for attaching tracing options and registering agents on the Mastra instance.
 */
export function isMastraTracingEnabled(): boolean {
  return isObservabilityEnabled() || isPhoenixCollectorEnabled();
}

export function phoenixCollectorEndpoint(): string {
  return (
    process.env.PHOENIX_COLLECTOR_ENDPOINT?.trim() ||
    'http://localhost:6006/v1/traces'
  );
}

export function phoenixProjectName(): string {
  return process.env.PHOENIX_PROJECT_NAME?.trim() || 'tourbillon';
}

export function shouldStoreModelChunks(): boolean {
  return process.env.OBSERVABILITY_STORE_MODEL_CHUNKS === 'true';
}

export function observabilityPreviewChars(): number {
  const parsed = parseInt(process.env.OBSERVABILITY_PREVIEW_CHARS ?? '500', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
}

export function observabilityMaxPayloadBytes(): number {
  const parsed = parseInt(process.env.OBSERVABILITY_MAX_PAYLOAD_BYTES ?? '32768', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 32768;
}
