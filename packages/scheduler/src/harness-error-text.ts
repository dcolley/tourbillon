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
 *
 * S331-4 NIT-1 (#335 review): the key layer only sees JSON KEYS — a third-party CLI printing an
 * env value on crash (`token=pm_run_...`, `sk-...`, a JWT) would pass the raw / unparseable-brace
 * path VERBATIM. A second, VALUE-based layer (`scrubSecretLikeValues`) runs over the final detail
 * (raw path AND the JSON path after key sanitization), replacing secret-looking tokens with
 * [REDACTED-value]. Patterns are deliberately conservative (prefix-anchored or length-floored) so
 * ordinary stderr — paths, stack lines, ECONNREFUSED, npm digests' words — survives; the
 * essence-not-utility trade says scrub a sha-style blob rather than risk a token.
 */
import { sanitizeForLogging } from '@tourbillon/shared/vault-encryption';

/** Matches the existing errorText cap convention (wake-runner apiError.responseBody.slice). */
export const HARNESS_ERROR_TEXT_CAP = 2000;

const VALUE_REDACTION = '[REDACTED-value]';

/**
 * Value-based secret scrub. Ordered, prefix-anchored or length-floored patterns only:
 *  - Tourbillon signed tokens: pm_run_/pm_chat_/agent tokens are `pm_<seg>[.<seg>]…`
 *    (shared/agent-token.ts) — anchored on `pm_`, first segment >= 8 chars so prose
 *    like `pm_2` or package names survive.
 *  - JWTs: three eyJ-prefixed base64url segments (header is `{"alg…` base64url).
 *  - Common API-key shapes: `sk-…` (>=16 body), and `Authorization: Bearer <tok>`.
 *  - Generic blobs: >=40-char hex (sha1-style digests, token-like entropy) and
 *    >=40-char base64 WITH padding (unpadded long alnum runs are NOT matched — that
 *    class is dominated by stack traces, digests-as-words, and long identifiers;
 *    real unpadded secrets of ours carry the prefixes above).
 */
export function scrubSecretLikeValues(text: string): string {
  return text
    .replace(/\bpm_[A-Za-z][A-Za-z0-9_-]{7,}(?:\.[A-Za-z0-9_-]+)*/g, VALUE_REDACTION)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, VALUE_REDACTION)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, VALUE_REDACTION)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/gi, 'Bearer ' + VALUE_REDACTION)
    .replace(/\b[0-9a-fA-F]{40,}\b/g, VALUE_REDACTION)
    .replace(/\b[A-Za-z0-9+/]{40,}={1,2}/g, VALUE_REDACTION);
}

/**
 * Sanitized detail, or undefined when there is nothing worth appending. The JSON payload
 * (when present from the first `{`) is key-sanitized via sanitizeForLogging; everything —
 * raw paths included — then goes through the VALUE layer above (NIT-1), so unparseable
 * brace text can no longer smuggle token-shaped strings to the Board.
 */
export function redactedHarnessErrorDetail(detail: string | undefined | null): string | undefined {
  if (typeof detail !== 'string') return undefined;
  const trimmed = detail.trim();
  if (!trimmed) return undefined;
  const idx = trimmed.indexOf('{');
  if (idx === -1) return scrubSecretLikeValues(trimmed);
  try {
    const parsed = JSON.parse(trimmed.slice(idx)) as unknown;
    if (parsed && typeof parsed === 'object') {
      return scrubSecretLikeValues((trimmed.slice(0, idx) + JSON.stringify(sanitizeForLogging(parsed))).trim());
    }
  } catch {
    // Not JSON — value layer still applies (NIT-1); the cap in the composer bounds length.
  }
  return scrubSecretLikeValues(trimmed);
}

/** `<base>: <redacted detail>` bounded to HARNESS_ERROR_TEXT_CAP, or `base` when no detail. */
export function harnessErrorTextWithDetail(base: string, detail: string | undefined | null): string {
  const safe = redactedHarnessErrorDetail(detail);
  const text = safe ? `${base}: ${safe}` : base;
  return text.slice(0, HARNESS_ERROR_TEXT_CAP);
}
