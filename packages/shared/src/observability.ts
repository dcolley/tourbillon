export const OBSERVABILITY_EVENT_TYPES = [
  'agent_run',
  'model_generation',
  'model_step',
  'tool_call',
  'mcp_tool_call',
  'generic',
] as const;

export type ObservabilityEventType = (typeof OBSERVABILITY_EVENT_TYPES)[number];

export const OBSERVABILITY_EVENT_STATUSES = ['ok', 'error'] as const;

export type ObservabilityEventStatus = (typeof OBSERVABILITY_EVENT_STATUSES)[number];

export function isObservabilityEnabled(): boolean {
  return process.env.OBSERVABILITY_ENABLED === 'true';
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
