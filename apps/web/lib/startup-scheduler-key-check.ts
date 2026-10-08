/**
 * Startup warning for SCHEDULER_API_KEY, called from instrumentation.ts register().
 *
 * The web server keeps booting with a bad key; enforcement stays at use time
 * (validateSchedulerKey in lib/auth/scheduler-key.ts, requireSchedulerApiKey in lib/wake-client.ts).
 * This only makes a misconfiguration visible as soon as the server starts: it logs one line naming
 * the variable and the reason, never the value, and never throws.
 *
 * It does nothing during `next build` (NEXT_PHASE === 'phase-production-build') and outside
 * the Node.js server runtime (NEXT_RUNTIME !== 'nodejs', e.g. the edge runtime).
 */
import {
  SCHEDULER_API_KEY_ENV,
  describeSchedulerApiKeyProblem,
  schedulerApiKeyProblem,
} from '@tourbillon/shared/scheduler-key';

export const SCHEDULER_KEY_PRODUCTION_BUILD_PHASE = 'phase-production-build';

type Env = Record<string, string | undefined>;
type Log = (message: string) => void;

/** True only in the Node.js server runtime, and never while `next build` runs. */
export function shouldRunStartupSchedulerKeyCheck(env: Env = process.env): boolean {
  if (env.NEXT_PHASE === SCHEDULER_KEY_PRODUCTION_BUILD_PHASE) return false;
  return env.NEXT_RUNTIME === 'nodejs';
}

/**
 * Log one line when SCHEDULER_API_KEY is unset, a placeholder or too short.
 * Returns true when a warning was logged. Never throws and never includes the value.
 */
export function runStartupSchedulerKeyCheck(
  env: Env = process.env,
  log: Log = (message) => console.error(message),
): boolean {
  try {
    if (!shouldRunStartupSchedulerKeyCheck(env)) return false;
    const problem = schedulerApiKeyProblem(env[SCHEDULER_API_KEY_ENV]);
    if (!problem) return false;
    log(
      `[tourbillon] WARNING: ${describeSchedulerApiKeyProblem(problem)}. Agent wakes, schedule sync ` +
        'and scheduler-key requests will fail until it is fixed.',
    );
    return true;
  } catch {
    // A startup warning must never stop the server.
    return false;
  }
}
