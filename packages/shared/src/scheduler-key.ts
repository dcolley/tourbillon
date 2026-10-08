/**
 * SCHEDULER_API_KEY: the shared bearer key between the web app and the scheduler process
 * (wake trigger, schedule sync, force-kill, routine issue create).
 *
 * One helper for both sides:
 * - `schedulerApiKeyProblem` / `requireSchedulerApiKey` check the configured value: it must be set,
 *   at least 32 characters, and not a placeholder from .env.example or the docs.
 * - `schedulerKeyMatches` compares a presented key with the configured one via SHA-256 digests and
 *   `crypto.timingSafeEqual` (equal-length buffers, so keys of any length never throw).
 *
 * Nothing here reads the environment at import time, so `next build` works with the var unset.
 * Errors and log text name the reason only, never the value. This module logs nothing itself.
 *
 * Self-contained on purpose; it could later share a generic "required secret" helper with
 * other secret settings.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const SCHEDULER_API_KEY_ENV = 'SCHEDULER_API_KEY';
export const SCHEDULER_API_KEY_MIN_LENGTH = 32;
export const SCHEDULER_API_KEY_GENERATE_HINT = 'generate one with: openssl rand -base64 32';

/** Placeholder values shipped in .env.example / docs (compared case-insensitively, trimmed). */
export const SCHEDULER_API_KEY_PLACEHOLDERS: readonly string[] = [
  'change-me-in-production',
  'dev-scheduler-key',
  '<generate with: openssl rand -base64 32>',
];

export type SchedulerApiKeyProblem = 'unset' | 'placeholder' | 'too_short';

const PROBLEM_TEXT: Record<SchedulerApiKeyProblem, string> = {
  unset: 'is not set',
  placeholder: 'is a placeholder value',
  too_short: `is shorter than ${SCHEDULER_API_KEY_MIN_LENGTH} characters`,
};

function isPlaceholder(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (SCHEDULER_API_KEY_PLACEHOLDERS.some((p) => p.toLowerCase() === v)) return true;
  // Template text such as "<generate …>" or any "change-me" variant.
  if (v.startsWith('<') && v.endsWith('>')) return true;
  return /change[-_ ]?me/.test(v);
}

/** Why the configured value is unusable, or null when it is fine. Never returns the value. */
export function schedulerApiKeyProblem(value: string | null | undefined): SchedulerApiKeyProblem | null {
  if (typeof value !== 'string' || value.trim() === '') return 'unset';
  if (isPlaceholder(value)) return 'placeholder';
  if (value.length < SCHEDULER_API_KEY_MIN_LENGTH) return 'too_short';
  return null;
}

/** Fixed, value-free description, e.g. "SCHEDULER_API_KEY is not set; generate one with: …". */
export function describeSchedulerApiKeyProblem(problem: SchedulerApiKeyProblem): string {
  return `${SCHEDULER_API_KEY_ENV} ${PROBLEM_TEXT[problem]}; ${SCHEDULER_API_KEY_GENERATE_HINT}`;
}

export class SchedulerKeyConfigError extends Error {
  readonly reason: SchedulerApiKeyProblem;
  constructor(reason: SchedulerApiKeyProblem) {
    super(describeSchedulerApiKeyProblem(reason));
    this.name = 'SchedulerKeyConfigError';
    this.reason = reason;
  }
}

type Env = Record<string, string | undefined>;

/** True when SCHEDULER_API_KEY is usable. */
export function isSchedulerApiKeyConfigured(env: Env = process.env): boolean {
  return schedulerApiKeyProblem(env[SCHEDULER_API_KEY_ENV]) === null;
}

/** The configured key, or throws SchedulerKeyConfigError (message names the reason, not the value). */
export function requireSchedulerApiKey(env: Env = process.env): string {
  const value = env[SCHEDULER_API_KEY_ENV];
  const problem = schedulerApiKeyProblem(value);
  if (problem) throw new SchedulerKeyConfigError(problem);
  return value as string;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Constant-time comparison of a presented key with the expected key. Both sides are hashed to
 * 32-byte SHA-256 digests first, so different lengths are rejected without throwing.
 * Empty / non-string input is rejected.
 */
export function schedulerKeyMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || presented === '') return false;
  if (typeof expected !== 'string' || expected === '') return false;
  return timingSafeEqual(sha256(presented), sha256(expected));
}

export type SchedulerKeyCheck =
  | { ok: true }
  | { ok: false; reason: 'mismatch' }
  | { ok: false; reason: 'config'; problem: SchedulerApiKeyProblem };

/**
 * Check a presented key against SCHEDULER_API_KEY. A misconfigured key (unset, placeholder, short)
 * rejects every request and reports `config` so the caller can log the reason.
 */
export function checkSchedulerApiKey(presented: unknown, env: Env = process.env): SchedulerKeyCheck {
  const expected = env[SCHEDULER_API_KEY_ENV];
  const problem = schedulerApiKeyProblem(expected);
  if (problem) return { ok: false, reason: 'config', problem };
  return schedulerKeyMatches(presented, expected as string) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/** Token from an `Authorization: Bearer <token>` header value, or '' when absent/malformed. */
export function bearerTokenFromHeader(header: string | null | undefined): string {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return '';
  return header.slice('Bearer '.length);
}
