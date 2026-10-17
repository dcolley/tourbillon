/**
 * Scheduler startup helpers: wait for Postgres with bounded backoff, sweep runs orphaned by a
 * previous worker process, and a testable main wrapper that exits non-zero on failure so
 * systemd (Restart=) brings the process back instead of leaving a dead-but-"active" unit.
 *
 * Everything logged from here goes through describeDbError: the underlying message and code,
 * sanitised (no connection URL, no password; user/host/database names may appear).
 */
import { DATABASE_URL_INVALID_CODE, describeDbError } from '@tourbillon/db/database-url';

export const DEFAULT_DB_WAIT_DEADLINE_MS = 120_000;
export const DEFAULT_DB_WAIT_INITIAL_DELAY_MS = 500;
export const DEFAULT_DB_WAIT_MAX_DELAY_MS = 10_000;
/** Upper bound for one probe attempt (handshake and query). */
export const DEFAULT_DB_ATTEMPT_TIMEOUT_MS = 10_000;
export const DB_PROBE_TIMEOUT_CODE = 'PROBE_TIMEOUT';

/**
 * Errors that retrying cannot fix: bad password / auth rejected (28P01, 28000), database does not
 * exist (3D000), or a malformed DATABASE_URL. These fail fast instead of burning the 2 min budget.
 */
export const FATAL_DB_ERROR_CODES: ReadonlySet<string> = new Set([
  '28P01',
  '28000',
  '3D000',
  DATABASE_URL_INVALID_CODE,
]);

export interface DbErrorInfo {
  message: string;
  code?: string;
}

export interface WaitForDbOptions {
  /** Total budget before giving up (default ~2 min). */
  deadlineMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Per-attempt bound; the attempt's AbortSignal fires when it elapses (default 10 s). */
  attemptTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Return true to stop retrying immediately. Default: FATAL_DB_ERROR_CODES. */
  isFatal?: (info: DbErrorInfo) => boolean;
  /** Called after each failed attempt with the sanitised message and code (never connection config). */
  onRetry?: (info: { attempt: number; delayMs: number; error: string; code?: string }) => void;
}

export class DbUnavailableError extends Error {
  constructor(
    readonly attempts: number,
    readonly lastError: string,
    readonly code?: string,
    readonly fatal = false,
  ) {
    super(
      fatal
        ? `database rejected the connection (not retried): ${lastError}`
        : `database not reachable after ${attempts} attempts: ${lastError}`,
    );
    this.name = 'DbUnavailableError';
  }
}

export class DbProbeTimeoutError extends Error {
  readonly code = DB_PROBE_TIMEOUT_CODE;
  constructor(ms: number) {
    super(`database probe timed out after ${ms} ms`);
    this.name = 'DbProbeTimeoutError';
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const isFatalDbError = (info: DbErrorInfo): boolean =>
  info.code !== undefined && FATAL_DB_ERROR_CODES.has(info.code);

/** Run one attempt, rejecting with DbProbeTimeoutError (and aborting the attempt) after `ms`. */
async function attemptWithTimeout(ping: (signal: AbortSignal) => Promise<unknown>, ms: number): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DbProbeTimeoutError(ms));
    }, ms);
  });
  try {
    await Promise.race([ping(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call `ping` until it resolves, with exponential backoff (doubling, capped at maxDelayMs) until
 * deadlineMs has elapsed. Each attempt is bounded by attemptTimeoutMs. Returns the number of
 * attempts used; throws DbUnavailableError on give-up or on a fatal (non-retryable) error.
 */
export async function waitForDb(
  ping: (signal: AbortSignal) => Promise<unknown>,
  opts: WaitForDbOptions = {},
): Promise<number> {
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DB_WAIT_DEADLINE_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_DB_WAIT_MAX_DELAY_MS;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_DB_ATTEMPT_TIMEOUT_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const isFatal = opts.isFatal ?? isFatalDbError;
  const start = now();
  let delayMs = opts.initialDelayMs ?? DEFAULT_DB_WAIT_INITIAL_DELAY_MS;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      await attemptWithTimeout(ping, attemptTimeoutMs);
      return attempt;
    } catch (err) {
      const info = describeDbError(err);
      if (isFatal(info)) throw new DbUnavailableError(attempt, info.message, info.code, true);
      const remaining = deadlineMs - (now() - start);
      if (remaining <= 0) throw new DbUnavailableError(attempt, info.message, info.code);
      const wait = Math.min(delayMs, maxDelayMs, remaining);
      opts.onRetry?.({ attempt, delayMs: wait, error: info.message, ...(info.code ? { code: info.code } : {}) });
      await sleep(wait);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }
}

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/** The only fields a startup failure log line may carry. */
export function startupFailureLogData(err: unknown): Record<string, unknown> {
  if (err instanceof DbUnavailableError) {
    return {
      error: err.lastError,
      ...(err.code ? { code: err.code } : {}),
      attempts: err.attempts,
      retried: !err.fatal,
    };
  }
  const info = describeDbError(err);
  return { error: info.message, ...(info.code ? { code: info.code } : {}) };
}

/**
 * Run the scheduler's start function; on any failure log the sanitised message and code (no
 * config, no stack) and exit non-zero. `exit` is injectable for tests.
 */
export async function runSchedulerMain(
  start: () => Promise<void>,
  logger: Logger,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  try {
    await start();
  } catch (err) {
    logger.error('failed to start; exiting non-zero so systemd restarts the unit', startupFailureLogData(err));
    exit(1);
  }
}
