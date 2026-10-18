/**
 * One redaction helper for every approval-details surface (page HTML, RSC data and
 * `GET /api/approvals/:id`). #130 Test B1/B2: nothing secret may reach any rendered field.
 *
 * What it removes:
 * - Values under credential-like keys, at any depth, case-insensitive (`token`, `apiKey`,
 *   `api_key`, `x-api-key`, `password`, `secret`, `resumeToken`, `authorization`, `cookie`,
 *   `clientSecret`, `privateKey`, `accessToken`/`refreshToken`, `credential`…), modelled on
 *   `sanitizeForLogging` in @tourbillon/shared. Key names stay; values become `[redacted]`.
 * - Inside every string: known secret values (raw, JSON-escaped and URL-encoded), `Bearer …` /
 *   `Basic …` credentials and URL userinfo/query/fragment (`scrubProviderSecrets` /
 *   `redactUrlsInText` from #125), `key=value` / `key: value` pairs with a credential-like key,
 *   `Cookie:` header lines and common token shapes (sk-…, ghp_…, xox…, AKIA…, JWTs).
 * - Optionally caps size and depth (payload display; Test S1).
 *
 * Known secret values are only ever held in memory here: never logged, never returned.
 */
import { SECRET_VALUE_MIN_LENGTH } from '@tourbillon/shared';
import { REDACTED, scrubProviderSecrets } from './provider-safety';

export { REDACTED };

/** Normalised (lower-case, alphanumerics only) fragments that mark a key as credential-bearing. */
const SENSITIVE_KEY_PARTS = [
  'token',
  'apikey',
  'password',
  'passwd',
  'passphrase',
  'secret',
  'authorization',
  'credential',
  'cookie',
  'privatekey',
  'accesskey',
  'sessionid',
  'encryptedvalue',
  'bearer',
];
/** Whole (normalised) key names that are credentials but too short to match as fragments. */
const SENSITIVE_KEY_EXACT = new Set(['auth', 'jwt', 'otp', 'pin', 'sig', 'signature']);

const normaliseKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/** True for keys whose values are credentials (`apiKey`, `X-API-Key`, `refresh_token`, …). */
export function isSensitiveKey(key: string): boolean {
  const k = normaliseKey(key);
  if (!k) return false;
  return SENSITIVE_KEY_EXACT.has(k) || SENSITIVE_KEY_PARTS.some((p) => k.includes(p));
}

/** Token *counts* (`maxTokens`, `inputTokens`, `tokenLimit`): numbers there are not secrets. */
function isTokenCountKey(key: string): boolean {
  const k = normaliseKey(key);
  return /tokens/.test(k) || /token(count|limit|budget|used|usage)/.test(k);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** `apiKey=…`, `"password": "…"`, `x-api-key: …` inside free text (Bearer/Basic handled later). */
const SENSITIVE_ASSIGNMENT_RE =
  /(\b[\w-]*(?:token|api[-_]?key|passw(?:or)?d|secret|authorization|credential|private[-_]?key|access[-_]?key)["']?\s*[:=]\s*["']?)(?!\[redacted\])(?!(?:Bearer|Basic)\s)[^\s"'&,;}<>()[\]]+/gi;
/** Whole `Cookie:` / `Set-Cookie:` header lines. */
const COOKIE_HEADER_RE = /(\b(?:set-)?cookie\s*:\s*)(?!\[redacted\])[^\r\n]+/gi;
/** Well-known credential shapes, redacted wherever they appear. */
const TOKEN_SHAPES_RE =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;

export interface DisplayCap {
  /** Objects/arrays nested deeper than this are replaced with a marker. */
  maxDepth: number;
  /** Longer strings are cut (after scrubbing) with a marker. */
  maxStringChars: number;
  maxArrayItems: number;
  maxObjectKeys: number;
  /** Rough budget of characters (strings + keys) for the whole value. */
  maxTotalChars: number;
}

/** Test S1: a 1,500-deep payload gave a 4.5 MB page in 48 s; a 5 MB payload a 5.1 MB page. */
export const PAYLOAD_DISPLAY_CAP: DisplayCap = {
  maxDepth: 12,
  maxStringChars: 2_000,
  maxArrayItems: 100,
  maxObjectKeys: 100,
  maxTotalChars: 50_000,
};

export interface ApprovalRedactor {
  /** Scrub one string. */
  text(s: string): string;
  /** Deep copy with credential keys and every string scrubbed. Dates/class instances pass through. */
  deep<T>(value: T): T;
  /** As `deep`, plus the size/depth cap; `truncated` says whether anything was cut. */
  capped(value: unknown, cap?: DisplayCap): { value: unknown; truncated: boolean };
}

/**
 * Build a redactor from known secret values (vault, provider keys, company settings, agent
 * runtime secrets, values found under credential keys). Values shorter than
 * SECRET_VALUE_MIN_LENGTH are ignored for value matching (they'd mangle unrelated text); they
 * are still covered by the key-name rule.
 */
export function createApprovalRedactor(knownValues: Iterable<string | null | undefined> = []): ApprovalRedactor {
  const variants: Array<[variant: string, secret: string]> = [];
  for (const raw of new Set(knownValues)) {
    if (typeof raw !== 'string' || raw.trim().length < SECRET_VALUE_MIN_LENGTH) continue;
    for (const v of [raw, raw.trim(), JSON.stringify(raw).slice(1, -1)]) variants.push([v, raw]);
    try {
      variants.push([encodeURIComponent(raw), raw]);
    } catch {
      // lone surrogate: no encoded form
    }
  }

  const text = (s: string): string => {
    if (!s) return s;
    // Only hand scrubProviderSecrets the secrets that actually occur (cheap pre-filter).
    const present = new Set<string>();
    for (const [v, secret] of variants) if (s.includes(v)) present.add(secret);
    // Known values (whole, all encodings), Bearer/Basic and URL userinfo/query first (#125),
    // then credential-looking assignments, Cookie headers and token shapes.
    return scrubProviderSecrets(s, present)
      .replace(COOKIE_HEADER_RE, `$1${REDACTED}`)
      .replace(SENSITIVE_ASSIGNMENT_RE, `$1${REDACTED}`)
      .replace(TOKEN_SHAPES_RE, REDACTED);
  };

  type State = { left: number; truncated: boolean };
  /** `forced`: inside a credential key's value (strings, and numbers unless token counts, go). */
  type Forced = null | { keepNumbers: boolean };

  const walk = (v: unknown, cap: DisplayCap | null, state: State, depth: number, forced: Forced): unknown => {
    if (typeof v === 'string') {
      if (forced) return v === '' ? v : REDACTED;
      const scrubbed = text(v);
      if (!cap) return scrubbed;
      if (state.left <= 0) {
        state.truncated = true;
        return '[truncated: display limit reached]';
      }
      const max = Math.min(cap.maxStringChars, state.left);
      state.left -= Math.min(scrubbed.length, max);
      if (scrubbed.length <= max) return scrubbed;
      state.truncated = true;
      return `${scrubbed.slice(0, max)}… [truncated: ${scrubbed.length - max} more chars]`;
    }
    if (typeof v === 'number' && forced && !forced.keepNumbers) return REDACTED;
    if (v === null || typeof v !== 'object') return v;
    if (cap && depth >= cap.maxDepth) {
      state.truncated = true;
      return `[truncated: nested deeper than ${cap.maxDepth} levels]`;
    }
    if (cap && state.left <= 0) {
      state.truncated = true;
      return '[truncated: display limit reached]';
    }
    if (Array.isArray(v)) {
      const items = cap ? v.slice(0, cap.maxArrayItems) : v;
      const out = items.map((x) => walk(x, cap, state, depth + 1, forced));
      if (cap && v.length > items.length) {
        state.truncated = true;
        out.push(`[truncated: ${v.length - items.length} more items]`);
      }
      return out;
    }
    if (!isPlainObject(v)) return forced ? REDACTED : v; // Date and other class instances
    const entries = Object.entries(v);
    const kept = cap ? entries.slice(0, cap.maxObjectKeys) : entries;
    const out: Record<string, unknown> = {};
    for (const [k, child] of kept) {
      const key = text(k);
      if (cap) state.left -= key.length;
      const childForced: Forced = forced ?? (isSensitiveKey(k) ? { keepNumbers: isTokenCountKey(k) } : null);
      out[key] = walk(child, cap, state, depth + 1, childForced);
    }
    if (cap && entries.length > kept.length) {
      state.truncated = true;
      out['…'] = `[truncated: ${entries.length - kept.length} more keys]`;
    }
    return out;
  };

  return {
    text,
    deep: <T,>(value: T) => walk(value, null, { left: Infinity, truncated: false }, 0, null) as T,
    capped(value, cap = PAYLOAD_DISPLAY_CAP) {
      const state = { left: cap.maxTotalChars, truncated: false };
      const out = walk(value, cap, state, 0, null);
      return { value: out, truncated: state.truncated };
    },
  };
}

/**
 * Strings held under credential keys anywhere in `value` (iterative, so any depth is safe;
 * bounded by `maxNodes`). Added to the known values so the same secret is also scrubbed from
 * the title, summary, HITLy error, notes and history.
 */
export function collectValuesUnderSensitiveKeys(value: unknown, maxNodes = 200_000): string[] {
  const found: string[] = [];
  const stack: Array<[unknown, boolean]> = [[value, false]];
  let nodes = 0;
  while (stack.length && nodes++ < maxNodes) {
    const [v, under] = stack.pop()!;
    if (typeof v === 'string') {
      if (under) found.push(v);
      continue;
    }
    if (v === null || typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      for (const x of v) stack.push([x, under]);
    } else if (isPlainObject(v)) {
      for (const [k, x] of Object.entries(v)) stack.push([x, under || isSensitiveKey(k)]);
    }
  }
  return found.filter((s) => s.trim().length >= SECRET_VALUE_MIN_LENGTH);
}
