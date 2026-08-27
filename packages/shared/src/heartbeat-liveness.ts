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
    /TripWire/i.test(message)
  );
}
