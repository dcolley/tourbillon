import { createTraceLogger } from './trace';

export const DEFAULT_HEARTBEAT_PING_INTERVAL_SEC = 20;
export const DEFAULT_HEARTBEAT_STALE_SEC = 90;

export interface HeartbeatLivenessConfig {
  pingIntervalMs: number;
  staleSec: number;
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

  return {
    pingIntervalMs: pingSec * 1000,
    staleSec,
  };
}

export function heartbeatStaleErrorText(staleSec: number): string {
  return `Heartbeat worker stopped responding (no ping within ${staleSec}s)`;
}
