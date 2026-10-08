/**
 * SCHEDULER_API_KEY handling for the scheduler process (kept free of db/mastra imports so it is
 * cheap to test).
 *
 * - `assertSchedulerApiKeyAtStartup` refuses to start when the key is unset, a placeholder or
 *   shorter than 32 characters. It logs the reason only, never the value.
 * - `authorizeSchedulerRequest` checks the bearer key on wake-server requests with the shared
 *   constant-time comparison.
 */
import {
  bearerTokenFromHeader,
  checkSchedulerApiKey,
  requireSchedulerApiKey,
  SchedulerKeyConfigError,
} from '@tourbillon/shared/scheduler-key';

export interface StartupLogger {
  error(message: string, data?: Record<string, unknown>): void;
}

type Env = Record<string, string | undefined>;

/** Throws SchedulerKeyConfigError after logging the reason when the key is unusable. */
export function assertSchedulerApiKeyAtStartup(log: StartupLogger, env: Env = process.env): void {
  try {
    requireSchedulerApiKey(env);
  } catch (err) {
    if (err instanceof SchedulerKeyConfigError) {
      log.error(`refusing to start: ${err.message}`, { reason: err.reason });
    }
    throw err;
  }
}

/** True when the request carries `Authorization: Bearer <SCHEDULER_API_KEY>`. */
export function authorizeSchedulerRequest(
  authorization: string | string[] | undefined,
  env: Env = process.env,
): boolean {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  return checkSchedulerApiKey(bearerTokenFromHeader(header), env).ok;
}
