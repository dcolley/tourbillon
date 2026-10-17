/**
 * Scheduler startup helpers: wait for Postgres with bounded backoff, sweep runs orphaned by a
 * previous worker process, and a testable main wrapper that exits non-zero on failure so
 * systemd (Restart=) brings the process back instead of leaving a dead-but-"active" unit.
 */

export const DEFAULT_DB_WAIT_DEADLINE_MS = 120_000;
export const DEFAULT_DB_WAIT_INITIAL_DELAY_MS = 500;
export const DEFAULT_DB_WAIT_MAX_DELAY_MS = 10_000;

export interface WaitForDbOptions {
  /** Total budget before giving up (default ~2 min). */
  deadlineMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called after each failed attempt. Receives only the error message (never connection config). */
  onRetry?: (info: { attempt: number; delayMs: number; error: string }) => void;
}

export class DbUnavailableError extends Error {
  constructor(
    readonly attempts: number,
    readonly lastError: string,
  ) {
    super(`database not reachable after ${attempts} attempts: ${lastError}`);
    this.name = 'DbUnavailableError';
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Call `ping` until it resolves, with exponential backoff (doubling, capped at maxDelayMs) until
 * deadlineMs has elapsed. Returns the number of attempts used; throws DbUnavailableError on give-up.
 */
export async function waitForDb(ping: () => Promise<unknown>, opts: WaitForDbOptions = {}): Promise<number> {
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DB_WAIT_DEADLINE_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_DB_WAIT_MAX_DELAY_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const start = now();
  let delayMs = opts.initialDelayMs ?? DEFAULT_DB_WAIT_INITIAL_DELAY_MS;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      await ping();
      return attempt;
    } catch (err) {
      const error = errorMessage(err);
      const remaining = deadlineMs - (now() - start);
      if (remaining <= 0) throw new DbUnavailableError(attempt, error);
      const wait = Math.min(delayMs, maxDelayMs, remaining);
      opts.onRetry?.({ attempt, delayMs: wait, error });
      await sleep(wait);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }
}

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/**
 * Run the scheduler's start function; on any failure log the message (no config/secrets) and
 * exit non-zero. `exit` is injectable for tests.
 */
export async function runSchedulerMain(
  start: () => Promise<void>,
  logger: Logger,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  try {
    await start();
  } catch (err) {
    logger.error('failed to start; exiting non-zero so systemd restarts the unit', {
      error: errorMessage(err),
    });
    exit(1);
  }
}
