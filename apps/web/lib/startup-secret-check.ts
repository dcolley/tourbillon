/**
 * Startup warning for required secrets, called from instrumentation.ts register().
 *
 * The real enforcement stays per request (requireSecret in lib/require-secret.ts, via
 * getAuth in lib/auth.ts). This only makes a misconfiguration visible as soon as the server
 * starts: it logs one line naming the variable and the reason, never the value, and never
 * throws.
 *
 * The loopback-only local-dev opt-in (TOURBILLON_BOARD_AUTH_INSECURE_DEV=1) is decided per
 * request from the request headers, so it cannot apply here; the warning is still logged and
 * says so.
 *
 * It does nothing during `next build` (NEXT_PHASE === 'phase-production-build') and outside
 * the Node.js server runtime (NEXT_RUNTIME !== 'nodejs', e.g. the edge runtime).
 */
import { SecretConfigError, secretProblem } from './require-secret';

/** Kept in sync with AUTH_SECRET_ENV in lib/auth.ts (not imported, to keep this module light). */
export const STARTUP_CHECKED_SECRETS = ['BETTER_AUTH_SECRET'] as const;

export const PRODUCTION_BUILD_PHASE = 'phase-production-build';

type Env = Record<string, string | undefined>;
type Log = (message: string) => void;

/** True only in the Node.js server runtime, and never while `next build` runs. */
export function shouldRunStartupSecretCheck(env: Env = process.env): boolean {
  if (env.NEXT_PHASE === PRODUCTION_BUILD_PHASE) return false;
  return env.NEXT_RUNTIME === 'nodejs';
}

/**
 * Log one line per misconfigured secret. Returns the variables that were reported.
 * Never throws and never includes a secret value in the output.
 */
export function runStartupSecretCheck(
  env: Env = process.env,
  log: Log = (message) => console.error(message),
): string[] {
  const reported: string[] = [];
  try {
    if (!shouldRunStartupSecretCheck(env)) return reported;
    for (const name of STARTUP_CHECKED_SECRETS) {
      const problem = secretProblem(env[name]);
      if (!problem) continue;
      const detail = new SecretConfigError(name, problem).message;
      log(
        `[tourbillon] WARNING: ${detail} Sign-in and session requests will fail until it is ` +
          `fixed (the loopback-only local-dev opt-in is checked per request).`,
      );
      reported.push(name);
    }
  } catch {
    // A startup warning must never stop the server.
  }
  return reported;
}
