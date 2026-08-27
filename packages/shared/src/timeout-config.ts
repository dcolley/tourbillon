/**
 * Timeout configuration helpers for agent heartbeat wall-clock timeout.
 */

export interface TimeoutConfig {
  heartbeatSec: number;
  graceSec: number;
}

const MIN_HEARTBEAT_TIMEOUT_SEC = 60;

/**
 * Parse and validate heartbeatSec from user input.
 * @param value - Raw input (string or number)
 * @param defaultValue - Fallback when parsing fails (default 300)
 * @returns Validated heartbeatSec (integer >= 60)
 */
export function parseHeartbeatTimeoutSec(
  value: string | number | null | undefined,
  defaultValue = 300,
): number {
  if (value == null || value === '') return defaultValue;
  
  const parsed = typeof value === 'string' ? Number(value) : value;
  
  if (!Number.isFinite(parsed)) return defaultValue;
  if (parsed < MIN_HEARTBEAT_TIMEOUT_SEC) return MIN_HEARTBEAT_TIMEOUT_SEC;
  
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
  
  return null;
}
