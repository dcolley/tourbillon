/**
 * S331-4 (#331): operator-facing failure detail for heartbeat_runs.errorText.
 *
 * The Hermes/OpenCode adapters put the real cause (exit code, HTTP status, JSON-RPC message)
 * on the dispatch result's `detail`, but wake-runner persisted only the static
 * 'Harness run failed' / stale-heartbeat string — the cause died in the tracer. These helpers
 * compose `<base>: <detail>` and pass the detail through the vault log sanitizer.
 *
 * sanitizeForLogging (@tourbillon/shared/vault-encryption) redacts by KEY substring
 * (token/secret/password/credential/value/...) — it is a no-op on bare strings, so the detail's
 * embedded JSON payload (when present) is parsed, sanitized, and re-serialized. Known
 * pre-existing quirk, pinned (NOT fixed) by harness-error-text.test.ts: the key match is a
 * substring, so a legitimate `inputTokens` field also comes back '[REDACTED]'.
 */
import { sanitizeForLogging } from '@tourbillon/shared/vault-encryption';

/** Matches the existing errorText cap convention (wake-runner apiError.responseBody.slice). */
export const HARNESS_ERROR_TEXT_CAP = 2000;

/**
 * Sanitized detail, or undefined when there is nothing worth appending. Non-JSON details
 * pass through verbatim (the sanitizer is identity on strings); the first `{`-onwards JSON
 * object, when parseable, is key-sanitized via sanitizeForLogging.
 */
export function redactedHarnessErrorDetail(detail: string | undefined | null): string | undefined {
  if (typeof detail !== 'string') return undefined;
  const trimmed = detail.trim();
  if (!trimmed) return undefined;
  const idx = trimmed.indexOf('{');
  if (idx === -1) return trimmed;
  try {
    const parsed = JSON.parse(trimmed.slice(idx)) as unknown;
    if (parsed && typeof parsed === 'object') {
      return (trimmed.slice(0, idx) + JSON.stringify(sanitizeForLogging(parsed))).trim();
    }
  } catch {
    // Not JSON — verbatim (fail-open on shape only; the cap below still bounds length).
  }
  return trimmed;
}

/** `<base>: <redacted detail>` bounded to HARNESS_ERROR_TEXT_CAP, or `base` when no detail. */
export function harnessErrorTextWithDetail(base: string, detail: string | undefined | null): string {
  const safe = redactedHarnessErrorDetail(detail);
  const text = safe ? `${base}: ${safe}` : base;
  return text.slice(0, HARNESS_ERROR_TEXT_CAP);
}
