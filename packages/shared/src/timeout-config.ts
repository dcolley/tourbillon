/**
 * Timeout configuration helpers for agent heartbeat wall-clock timeout.
 */

export interface TimeoutConfig {
  heartbeatSec: number;
  graceSec: number;
}

const MIN_HEARTBEAT_TIMEOUT_SEC = 60;
const DEFAULT_TIMEOUT_SEC = 300;
/**
 * Upper bound for a heartbeat's wall-clock timeout (23h). Every run gets a finite wall clock, and
 * the run token (timeout + 15 min grace, see agent-token.ts) always outlives it inside the 24h cap.
 */
export const MAX_HEARTBEAT_TIMEOUT_SEC = 23 * 60 * 60;

/**
 * Wall-clock timeout actually enforced for a heartbeat run (and used for the run token TTL).
 * - unset / non-numeric → 300s default (same as the old `?? 300`)
 * - <= 0 (legacy "no limit") or above the cap → MAX_HEARTBEAT_TIMEOUT_SEC
 * - otherwise the configured value, unchanged
 */
export function effectiveHeartbeatTimeoutSec(value: unknown): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_TIMEOUT_SEC;
  if (n <= 0 || n > MAX_HEARTBEAT_TIMEOUT_SEC) return MAX_HEARTBEAT_TIMEOUT_SEC;
  return n;
}

/**
 * Parse and validate heartbeatSec from user input.
 * @param value - Raw input (string or number)
 * @param defaultValue - Fallback when parsing fails (default 300)
 * @returns Validated heartbeatSec (integer, 60 ≤ n ≤ MAX_HEARTBEAT_TIMEOUT_SEC)
 */
export function parseHeartbeatTimeoutSec(
  value: string | number | null | undefined,
  defaultValue = 300,
): number {
  if (value == null || value === '') return defaultValue;
  
  const parsed = typeof value === 'string' ? Number(value) : value;
  
  if (!Number.isFinite(parsed)) return defaultValue;
  if (parsed < MIN_HEARTBEAT_TIMEOUT_SEC) return MIN_HEARTBEAT_TIMEOUT_SEC;
  if (parsed > MAX_HEARTBEAT_TIMEOUT_SEC) return MAX_HEARTBEAT_TIMEOUT_SEC;
  
  return Math.floor(parsed);
}

/**
 * Validate that a timeout config has valid heartbeatSec.
 * @returns Error message if invalid, null if valid
 */
export function validateTimeoutConfig(timeout: Partial<TimeoutConfig> | null | undefined): string | null {
  if (!timeout) return null;
  
  const { heartbeatSec } = timeout;
  if (heartbeatSec == null) return null;
  
  if (!Number.isInteger(heartbeatSec)) {
    return 'Timeout must be an integer.';
  }
  
  if (heartbeatSec < MIN_HEARTBEAT_TIMEOUT_SEC) {
    return `Timeout must be at least ${MIN_HEARTBEAT_TIMEOUT_SEC} seconds.`;
  }

  if (heartbeatSec > MAX_HEARTBEAT_TIMEOUT_SEC) {
    return `Timeout must be at most ${MAX_HEARTBEAT_TIMEOUT_SEC} seconds (23h).`;
  }
  
  return null;
}
