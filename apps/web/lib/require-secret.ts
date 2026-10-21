/**
 * Shared check for required secrets read from the environment.
 *
 * `requireSecret(name)` returns the configured value, or throws when the variable is unset,
 * shorter than MIN_SECRET_LENGTH, or a known placeholder. It applies whatever NODE_ENV is.
 *
 * The only exception is the local-dev opt-in used by board auth
 * (`TOURBILLON_BOARD_AUTH_INSECURE_DEV=1`, NODE_ENV !== 'production', and every request host
 * loopback; see `isInsecureDevBoardAuth` in lib/board-auth.ts). It needs request headers, so
 * it never applies without them.
 *
 * Error messages name the variable but never include its value.
 */
import { isInsecureDevBoardAuth, type BoardRequestHeaders } from './board-auth';
import { isPlaceholderSecret } from './secret-placeholder';

export const MIN_SECRET_LENGTH = 32;

/** Value used under the loopback-only local-dev opt-in when the variable is unset. */
export const INSECURE_DEV_FALLBACK_SECRET = 'change-me-in-production';

export type SecretProblem = 'unset' | 'placeholder' | 'too_short';

/** Why a configured value is not acceptable, or null when it is. Never inspects other env. */
export function secretProblem(value: string | null | undefined): SecretProblem | null {
  const v = value?.trim();
  if (!v) return 'unset';
  if (isPlaceholderSecret(v)) return 'placeholder';
  if (v.length < MIN_SECRET_LENGTH) return 'too_short';
  return null;
}

const PROBLEM_TEXT: Record<SecretProblem, string> = {
  unset: 'is not set',
  placeholder: 'is set to a placeholder value',
  too_short: `is shorter than ${MIN_SECRET_LENGTH} characters`,
};

export class SecretConfigError extends Error {
  readonly variable: string;
  readonly problem: SecretProblem;

  constructor(variable: string, problem: SecretProblem) {
    super(
      `${variable} ${PROBLEM_TEXT[problem]}. Set ${variable} to a random value of at least ` +
        `${MIN_SECRET_LENGTH} characters (e.g. openssl rand -base64 32).`,
    );
    this.name = 'SecretConfigError';
    this.variable = variable;
    this.problem = problem;
  }
}

/**
 * Return the configured secret `name`, or throw SecretConfigError.
 * Pass the request headers so the loopback-only local-dev opt-in can apply.
 */
export function requireSecret(name: string, headers?: BoardRequestHeaders): string {
  const raw = process.env[name];
  const problem = secretProblem(raw);
  if (!problem) return raw as string;
  if (isInsecureDevBoardAuth(headers)) {
    return raw?.trim() ? (raw as string) : INSECURE_DEV_FALLBACK_SECRET;
  }
  throw new SecretConfigError(name, problem);
}
