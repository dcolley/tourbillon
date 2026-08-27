import { createTraceLogger } from './trace';

export const DEFAULT_HEARTBEAT_PING_INTERVAL_SEC = 20;
export const DEFAULT_HEARTBEAT_STALE_SEC = 90;
/** No harness controller progress (tool/model/OM events) within this window → abort wake. */
export const DEFAULT_HEARTBEAT_PROGRESS_STALE_SEC = 600;

export interface HeartbeatLivenessConfig {
  pingIntervalMs: number;
  staleSec: number;
  /** Sliding progress timeout for harness Session (separate from event-loop ping stale). */
  progressStaleSec: number;
}

const livenessTracer = createTraceLogger('heartbeat-liveness', {});

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    livenessTracer.warn(`invalid ${name}, using default`, { raw, fallback });
    return fallback;
  }
  return parsed;
}

/** Shared liveness config for scheduler worker pings and reconciler sweeps. */
export function resolveHeartbeatLivenessConfig(): HeartbeatLivenessConfig {
  const pingSec = parsePositiveIntEnv(
    'HEARTBEAT_PING_INTERVAL_SEC',
    DEFAULT_HEARTBEAT_PING_INTERVAL_SEC,
  );
  const staleSecRaw = parsePositiveIntEnv('HEARTBEAT_STALE_SEC', DEFAULT_HEARTBEAT_STALE_SEC);
  const minStaleSec = pingSec * 2;
  const staleSec = Math.max(staleSecRaw, minStaleSec);

  if (staleSecRaw < minStaleSec) {
    livenessTracer.warn('HEARTBEAT_STALE_SEC below 2x ping interval; clamped', {
      requested: staleSecRaw,
      pingSec,
      effective: staleSec,
    });
  }

  const progressStaleSec = parsePositiveIntEnv(
    'HEARTBEAT_PROGRESS_STALE_SEC',
    DEFAULT_HEARTBEAT_PROGRESS_STALE_SEC,
  );

  return {
    pingIntervalMs: pingSec * 1000,
    staleSec,
    progressStaleSec,
  };
}

export function heartbeatStaleErrorText(staleSec: number): string {
  return `Heartbeat worker stopped responding (no ping within ${staleSec}s)`;
}

/**
 * Determines if a heartbeat can be force-killed by the operator.
 * Only queued or running heartbeats can be killed.
 */
export function canForceKillHeartbeat(status: string): boolean {
  return status === 'queued' || status === 'running';
}

export interface HeartbeatProgressLastEvent {
  type: string;
  at: Date;
}

export function heartbeatProgressStaleErrorText(
  progressStaleSec: number,
  lastEvent?: HeartbeatProgressLastEvent | null,
): string {
  const base = `Heartbeat made no progress (no controller events within ${progressStaleSec}s)`;
  if (!lastEvent?.type) {
    return `${base}; last event: none`;
  }
  return `${base}; last event: ${lastEvent.type} at ${lastEvent.at.toISOString()}`;
}

/** True when an error looks like Mastra TokenLimiter / TripWire context failure. */
export function isTokenLimiterTripwireError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return (
    /TokenLimiterProcessor/i.test(message) ||
    /No messages fit within the remaining token budget/i.test(message) ||
    /No messages to process/i.test(message) ||
    /System messages alone exceed/i.test(message) ||
    /TripWire/i.test(message)
  );
}

/**
 * True when an error or span output indicates the system-messages-alone tripwire.
 * This is the fatal case where system prompt + tool schemas exceed the context window
 * before any history is added.
 */
export function isSystemMessageTripwire(value: unknown): boolean {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return /System messages alone exceed/i.test(text);
}

/**
 * Extract token counts from a system-message tripwire error or span output.
 * Returns { systemTokens, limit } when both are found, or partial when only one is available.
 * 
 * Prefers metadata fields over regex parsing when available (Mastra tripwire chunk shape).
 */
export function extractTripwireTokenCounts(value: unknown): {
  systemTokens?: number;
  limit?: number;
} {
  // Try structured metadata first (Mastra tripwire chunk)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    
    // Check for options.metadata (TripWire shape)
    const options = obj.options as Record<string, unknown> | undefined;
    if (options?.metadata && typeof options.metadata === 'object') {
      const metadata = options.metadata as Record<string, unknown>;
      const systemTokens = typeof metadata.systemTokens === 'number' ? metadata.systemTokens : undefined;
      const limit = typeof metadata.limit === 'number' ? metadata.limit : undefined;
      if (systemTokens !== undefined || limit !== undefined) {
        return { systemTokens, limit };
      }
    }
    
    // Check for direct metadata fields (alternative shape)
    const metadata = obj.metadata as Record<string, unknown> | undefined;
    if (metadata) {
      const systemTokens = typeof metadata.systemTokens === 'number' ? metadata.systemTokens : undefined;
      const limit = typeof metadata.limit === 'number' ? metadata.limit : undefined;
      if (systemTokens !== undefined || limit !== undefined) {
        return { systemTokens, limit };
      }
    }
    
    // Check for top-level fields
    const systemTokens = typeof obj.systemTokens === 'number' ? obj.systemTokens : undefined;
    const limit = typeof obj.limit === 'number' ? obj.limit : undefined;
    if (systemTokens !== undefined || limit !== undefined) {
      return { systemTokens, limit };
    }
  }
  
  // Fall back to regex parsing
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const systemMatch = text.match(/system.*?(\d+)\s*tokens/i);
  const limitMatch = text.match(/limit.*?(\d+)/i);
  
  return {
    systemTokens: systemMatch ? Number.parseInt(systemMatch[1], 10) : undefined,
    limit: limitMatch ? Number.parseInt(limitMatch[1], 10) : undefined,
  };
}

/**
 * Format a system-message tripwire error with token counts.
 */
export function formatSystemMessageTripwireError(
  systemTokens?: number,
  limit?: number
): string {
  if (systemTokens !== undefined && limit !== undefined) {
    return `System messages are ${systemTokens} tokens (limit ${limit}). Cannot trim further.`;
  }
  if (systemTokens !== undefined) {
    return `System messages are ${systemTokens} tokens. Cannot trim further.`;
  }
  if (limit !== undefined) {
    return `System messages exceed limit (${limit} tokens). Cannot trim further.`;
  }
  return 'System messages alone exceed token limit. Cannot trim further.';
}
