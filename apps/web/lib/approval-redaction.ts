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
 *
 * Vault values (#130 B3): when the company's vault rows can't all be decrypted (key unset, wrong
 * or rotated, or a corrupt row), the redactor can't know every value to remove, so every free-text
 * field that could echo one is replaced with REDACTION_UNAVAILABLE (`redactor.freeText`). Status,
 * dates, actors and ids still render; key-name, Bearer and URL scrubbing still run on everything.
 */
import { SECRET_VALUE_MIN_LENGTH } from '@tourbillon/shared';
import { decryptCredential } from '@tourbillon/shared/vault-encryption';
import { REDACTED, scrubProviderSecrets } from './provider-safety';

export { REDACTED };

/** Shown instead of free text when the vault values needed to scrub it can't be loaded. */
export const REDACTION_UNAVAILABLE = 'hidden: redaction unavailable';

/** Known secret values for one company, plus whether the vault part is complete. */
export interface KnownSecretValues {
  values: string[];
  /** True when one or more vault rows (or the vault key) could not be used: hide free text. */
  vaultUnavailable: boolean;
}

/**
 * Policy for a vault where SOME rows decrypt and others don't. `false` (default): any row that
 * can't be decrypted hides free text, like a missing or wrong key. Set to `true` to skip just the
 * bad rows and keep rendering with the rest. A missing key, or every row failing (wrong/rotated
 * key), always hides free text whatever this says.
 *
 * Deliberately a code constant (no env read). If it is ever wired to an env var, parse it
 * explicitly: only '1' or 'true' turn it on; any other value (including 'false', '0', '') is off.
 */
export const SKIP_UNDECRYPTABLE_VAULT_ROWS: boolean = false;

/**
 * Plain strings from a company's vault rows (API-key strings, OAuth access/refresh tokens), for
 * redaction only. Never throws. Logs only counts and row ids (never values or ciphertext).
 */
export function vaultValuesForRedaction(
  rows: ReadonlyArray<{ id: string; encryptedValue: string }>,
  opts: { skipUndecryptableRows?: boolean; log?: (msg: string, meta: Record<string, unknown>) => void } = {},
): KnownSecretValues {
  const skipBadRows = opts.skipUndecryptableRows ?? SKIP_UNDECRYPTABLE_VAULT_ROWS;
  const log = opts.log ?? ((msg, meta) => console.warn(msg, meta));
  if (rows.length === 0) return { values: [], vaultUnavailable: false };
  const keyMissing = !process.env.VAULT_ENCRYPTION_KEY;
  const values: string[] = [];
  const failedRowIds: string[] = [];
  for (const row of rows) {
    try {
      const v = decryptCredential(row.encryptedValue);
      if (typeof v === 'string') values.push(v);
      else values.push(...[v.accessToken, v.refreshToken].filter((x): x is string => typeof x === 'string'));
    } catch {
      failedRowIds.push(row.id);
    }
  }
  if (failedRowIds.length === 0) return { values, vaultUnavailable: false };
  const whole = keyMissing || failedRowIds.length === rows.length;
  const vaultUnavailable = whole || !skipBadRows;
  log('[approval redaction] vault values unavailable', {
    reason: keyMissing ? 'key_missing' : whole ? 'no_row_decrypts' : 'row_decrypt_failed',
    rows: rows.length,
    failed: failedRowIds.length,
    failedRowIds: failedRowIds.slice(0, 50),
    hidingFreeText: vaultUnavailable,
  });
  return { values, vaultUnavailable };
}

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
  'pwd',
  'dsn',
  'connectionstring',
  'xauth',
];
/** Whole (normalised) key names that are credentials but too short to match as fragments. */
const SENSITIVE_KEY_EXACT = new Set(['auth', 'jwt', 'otp', 'pin', 'sig', 'signature', 'pass']);

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

/**
 * Bare `key=value` / `key: value` / `"key": "value"` inside free text. Key kept, value masked when
 * the key name looks secret (isSensitiveKey).
 *
 * A single left-to-right pass over the `=` / `:` separators (linear in the text length):
 * - The key is the whole run of `[A-Za-z0-9_.-]` before the separator (optionally quoted, blanks
 *   allowed before the separator), so `--db-password=`, `.secret=`, `my.secret=` and keys of any
 *   length are judged on their full name.
 * - A non-secret pair never swallows what follows it: scanning resumes right after its separator,
 *   so `redirect=/cb?token=…`, `user:password=…` and `wss://h/p?token=…` are each checked.
 * - Values: `"…"` / `'…'` (backslash escapes allowed; an unterminated quote runs to the end of the
 *   line) or unquoted up to whitespace or `"'&,;}<>()[]`. For Authorization-style keys a
 *   `<scheme> <credential>` value (`Token`, `Bot`, `Digest`, `ApiKey`…) masks the credential.
 * - Token-count keys (`max_tokens`, `token_count`, `auth_tokens`…) keep numeric values only.
 * - `Bearer [redacted]` / `Basic [redacted]` (already masked by scrubProviderSecrets) are left as is.
 */
const isKeyCode = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 45;
const isBlankCode = (c: number) => c === 32 || c === 9;
const isLineEndCode = (c: number) => c === 10 || c === 13;
/** Characters that end an unquoted value: whitespace and `"'&,;}<>()[]`. */
const UNQUOTED_VALUE_END = /[\s"'&,;}<>()[\]]/;
const isUnquotedEnd = (ch: string) => UNQUOTED_VALUE_END.test(ch);
const NUMERIC_VALUE_RE = /^-?\d+(?:\.\d+)?$/;
const MASKED_SCHEME_RE = /^["']?(?:Bearer|Basic)\s+\[redacted\]/i;
const SEPARATOR_RE = /[:=]/g;
/** Authorization schemes other than Bearer/Basic (those are handled by scrubProviderSecrets). */
const AUTH_SCHEME_RE = /^(?:Token|Bot|Digest|ApiKey|Api-Key|Key|SSWS|OAuth|DPoP|Negotiate|NTLM|HOBA|Mutual|AWS4-HMAC-SHA256|Bearer|Basic)$/i;

/** Authorization-style keys, whose unquoted value may be `<scheme> <credential>`. */
function isAuthHeaderKey(key: string): boolean {
  const k = normaliseKey(key);
  return k === 'auth' || k.endsWith('authorization') || k === 'xauth';
}

/** End (exclusive) of an unquoted value starting at `from`. */
function unquotedEnd(s: string, from: number): number {
  let j = from;
  while (j < s.length && !isUnquotedEnd(s[j])) j++;
  return j;
}

function scrubSensitiveAssignments(s: string): string {
  if (!s.includes('=') && !s.includes(':')) return s;
  const out: string[] = [];
  let copied = 0; // s[0, copied) is already in `out`
  SEPARATOR_RE.lastIndex = 0;
  for (let m = SEPARATOR_RE.exec(s); m; m = SEPARATOR_RE.exec(s)) {
    const sep = m.index;
    // Key: walk back over blanks, an optional closing quote, then the key run (never into text
    // already handled).
    let k = sep;
    while (k > copied && isBlankCode(s.charCodeAt(k - 1))) k--;
    let quote = '';
    if (k > copied && (s[k - 1] === '"' || s[k - 1] === "'")) quote = s[--k];
    const keyEnd = k;
    while (k > copied && isKeyCode(s.charCodeAt(k - 1))) k--;
    if (k === keyEnd) continue;
    if (quote && (k === copied || s[k - 1] !== quote)) continue;
    const key = s.slice(k, keyEnd);
    if (!isSensitiveKey(key)) continue; // resume right after this separator

    // Value.
    let v = sep + 1;
    while (v < s.length && isBlankCode(s.charCodeAt(v))) v++;
    if (v >= s.length) continue;
    if (MASKED_SCHEME_RE.test(s.slice(v, v + 64))) continue;
    const open = s[v];
    let end: number;
    let inner: string;
    let masked: string;
    if (open === '"' || open === "'") {
      let j = v + 1;
      let closed = false;
      while (j < s.length) {
        const c = s.charCodeAt(j);
        if (s[j] === open) {
          closed = true;
          break;
        }
        if (isLineEndCode(c)) break;
        if (c === 92 /* \\ */ && j + 1 < s.length && !isLineEndCode(s.charCodeAt(j + 1))) j += 2;
        else j++;
      }
      inner = s.slice(v + 1, Math.min(j, s.length));
      end = closed ? j + 1 : Math.min(j, s.length);
      masked = `${open}${REDACTED}${closed ? open : ''}`;
    } else {
      end = unquotedEnd(s, v);
      if (end === v) continue;
      inner = s.slice(v, end);
      masked = REDACTED;
      // `Authorization: Token abc`: the credential after a scheme word goes too.
      if (isAuthHeaderKey(key) && AUTH_SCHEME_RE.test(inner)) {
        let c = end;
        while (c < s.length && isBlankCode(s.charCodeAt(c))) c++;
        const credEnd = c > end ? unquotedEnd(s, c) : c;
        if (credEnd > c && s.slice(c, credEnd) !== REDACTED) {
          masked = `${inner}${s.slice(end, c)}${REDACTED}`;
          end = credEnd;
        }
      }
    }
    const keep = inner === REDACTED || (isTokenCountKey(key) && NUMERIC_VALUE_RE.test(inner));
    if (!keep) {
      out.push(s.slice(copied, v), masked);
      copied = end;
    }
    SEPARATOR_RE.lastIndex = Math.max(end, sep + 1);
  }
  if (copied === 0) return s;
  out.push(s.slice(copied));
  return out.join('');
}
/** Whole `Cookie:` / `Set-Cookie:` header lines. */
const COOKIE_HEADER_RE = /(\b(?:set-)?cookie\s*:\s*)(?!\[redacted\])[^\r\n]+/gi;
/** PEM blocks (keys, certificates); an unterminated block is cut to the end of the string. */
const PEM_BLOCK_RE = /-----BEGIN [A-Z0-9 ]{1,64}-----(?:[\s\S]*?-----END [A-Z0-9 ]{1,64}-----|[\s\S]*$)/g;
/**
 * Userinfo password in a URL of any scheme (`postgres://user:pw@`, `redis://:pw@`, `wss://…`);
 * http(s) userinfo is already removed whole by redactUrlsInText. Without a `:` the whole userinfo
 * goes (`scheme://token@host`). Up to the last `@` before the path, so `@` in a password is covered.
 * The scheme part is at most 32 characters, so each start position looks at a bounded window and
 * long dotted/dashed runs (`a.a.a…`) stay linear.
 */
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/?#"'<>`]*)@/gi;
const scrubUserinfo = (_m: string, scheme: string, userinfo: string) => {
  const colon = userinfo.indexOf(':');
  return colon === -1 ? `${scheme}${REDACTED}@` : `${scheme}${userinfo.slice(0, colon)}:${REDACTED}@`;
};
/**
 * Well-known credential shapes, redacted wherever they appear. A JWT only starts at the start of
 * a `[A-Za-z0-9_-]` run, so a long `eyJ-eyJ-…` run is tried once, not once per `eyJ`.
 */
const TOKEN_SHAPES_RE =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;

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
  /** True when vault values could not be loaded (see REDACTION_UNAVAILABLE). */
  readonly unavailable: boolean;
  /** Scrub one string. */
  text(s: string): string;
  /**
   * Free text that may echo a vault value (payload title/summary, notes, HITLy error, issue
   * titles): REDACTION_UNAVAILABLE when the vault values are unavailable (empty stays empty),
   * otherwise `text(s)`.
   */
  freeText(s: string): string;
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
export function createApprovalRedactor(
  knownValues: Iterable<string | null | undefined> = [],
  opts: { vaultUnavailable?: boolean } = {},
): ApprovalRedactor {
  const unavailable = opts.vaultUnavailable === true;
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
    return scrubSensitiveAssignments(
      scrubProviderSecrets(s.replace(PEM_BLOCK_RE, REDACTED), present)
        .replace(URL_USERINFO_RE, scrubUserinfo)
        .replace(COOKIE_HEADER_RE, `$1${REDACTED}`),
    ).replace(TOKEN_SHAPES_RE, REDACTED);
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

  const freeText = (s: string): string => (unavailable && s ? REDACTION_UNAVAILABLE : text(s));

  return {
    unavailable,
    text,
    freeText,
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
