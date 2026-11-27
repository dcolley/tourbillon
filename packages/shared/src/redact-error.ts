/**
 * TB-HOTFIX-REDACT: the ONE redactor for technical text that may echo secrets.
 *
 * Why: task-progress notices (started / done / waiting_on_user / failed) interpolate
 * scheduler-provided `title` and `detail` straight into persisted signal contents, and the
 * web notice path prints them for every stage. A provider error string that echoes a key,
 * a token, or a URL userinfo password used to be stored, replayed by history GET, and
 * printed in SSR HTML verbatim.
 *
 * Rules (contract §2/§4):
 *  - redact FIRST, clamp LAST (M14: a secret past the cap must not survive as a prefix);
 *  - technical text is capped at TECHNICAL_MAX_CHARS with a visible truncation marker
 *    (same constant spirit as #364 TECHNICAL_MAX_CHARS);
 *  - non-secret tokens must survive (M11): `ECONNREFUSED`, `exit 137`, free-form asks,
 *    `reply here`, task titles — the redactor only ever removes secret material.
 *
 * Fixtures are synthetic only. This module must never log what it redacted.
 */

/** Cap for redacted technical text (toggle body, persisted technical field). */
export const TECHNICAL_MAX_CHARS = 2000;

/** Marker appended when technical text was clamped. */
export const TRUNCATION_MARKER = '…[truncated]';

/** Placeholder substituted for every secret match. */
const REDACTED = '[redacted]';

/**
 * Secret shapes (contract §4 F1–F9 + SHOULD-4 Slack tokens). Each rule is anchored so
 * ordinary words are never eaten (e.g. `(?<![A-Za-z0-9])sk-` never matches inside "task-…").
 */
const SECRET_RULES: ReadonlyArray<RegExp> = [
  // F1/F2: OpenAI-style keys incl. sk-ant-api03-… and sk-proj-…
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/g,
  // F3/F4: GitHub tokens.
  /(?<![A-Za-z0-9])(?:ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})/g,
  // F6: AWS access key ids.
  /(?<![A-Za-z0-9])AKIA[A-Z0-9]{12,}/g,
  // F7: JWTs (three base64url segments; the header always starts with eyJ).
  /eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/g,
  // F5: Bearer values.
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/g,
  // F8: URL userinfo password (scheme://user:PASSWORD@host — the hostname may stay).
  /([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]*:)[^\s@]+@/g,
  // F8 (truncation-safe): a clamped/truncated credential right after the user: colon
  // (no closing '@' in view) must not survive either.
  /([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]*:)[^\s,;"'`@)\]}]+/g,
  // F9: ENV key=value lines whose key names a credential (underscores allowed).
  /\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)=(\S+)/g,
  // SHOULD-4: Slack tokens.
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g,
  // SHOULD-1: private / loopback addresses and .local hostnames in technical text.
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g,
  /\b(?:[A-Za-z0-9-]+\.)+local\b/g,
];

/**
 * SHOULD-3: known-secret VALUES (e.g. a company registered secret) that no shape rule
 * covers. Hosts register them at boot; the redactor scrubs every occurrence. Values are
 * held in module scope only and are never echoed back.
 */
let knownSecretValues: string[] = [];

/** Register exact secret values to scrub from every redacted string (SHOULD-3). */
export function registerKnownSecrets(values: Iterable<string>): void {
  for (const v of values) {
    const trimmed = typeof v === 'string' ? v.trim() : '';
    if (trimmed.length >= 6 && !knownSecretValues.includes(trimmed)) knownSecretValues.push(trimmed);
  }
}

/** Test/host hook: forget all registered known-secret values. */
export function clearKnownSecrets(): void {
  knownSecretValues = [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redact secret material from technical text, THEN clamp to TECHNICAL_MAX_CHARS.
 * Never blanks ordinary text: a string without secret material passes through unchanged
 * apart from the cap (MUST-7 / M11).
 */
export function redactErrorText(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  let out = text;
  for (const rule of SECRET_RULES) {
    // Reset shared /g lastIndex safety: replace() ignores lastIndex, rules are safe.
    out = out.replace(rule, (match, ...groups) => {
      // F8 keeps its scheme://user: prefix; every other rule replaces whole.
      if (typeof groups[0] === 'string' && groups[0].endsWith(':') && /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(groups[0])) {
        // Keep the '@' only when the match actually consumed one (the truncation-safe
        // variant of the rule ends at whitespace without it).
        return match.endsWith('@') ? `${groups[0]}***@` : `${groups[0]}***`;
      }
      // F9 keeps the ENV key name.
      if (typeof groups[0] === 'string' && /^[A-Z][A-Z0-9_]*$/.test(groups[0])) {
        return `${groups[0]}=${REDACTED}`;
      }
      return REDACTED;
    });
  }
  for (const known of knownSecretValues) {
    if (out.includes(known)) out = out.split(known).join(REDACTED);
  }
  if (out.length > TECHNICAL_MAX_CHARS) {
    out = `${out.slice(0, TECHNICAL_MAX_CHARS)}${TRUNCATION_MARKER}`;
  }
  return out;
}

/** Model-directed instruction lines that must never reach the human-visible notice (MUST-2). */
const NOTICE_DIRECTIVE_TRIGGERS: ReadonlyArray<RegExp> = [
  /Tell the human/i,
  /do NOT present/i,
  /offer a retry \(resume re-queues it\)/i,
  /Ask them for exactly that/i,
];

function isDirectiveClause(clause: string): boolean {
  return NOTICE_DIRECTIVE_TRIGGERS.some((re) => re.test(clause));
}

/**
 * Strip model-directed instructions from a notice line while keeping the human-facing
 * content (the exact ask, the "reply here" hint, the failure reason). Applied per
 * sentence; a triggered sentence is dropped clause-by-clause so sibling clauses that the
 * human needs ("they can reply here") survive (TB-363 A2 / MUST-7).
 */
export function stripNoticeDirectives(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept: string[] = [];
  for (const sentence of sentences) {
    if (!isDirectiveClause(sentence)) {
      kept.push(sentence);
      continue;
    }
    const clauses = sentence
      .split(/;\s*|\s+—\s+/)
      .map((c) => c.trim())
      .filter((c) => c.length > 0 && !isDirectiveClause(c));
    if (clauses.length > 0) kept.push(clauses.join('; '));
  }
  return kept.join(' ').trim();
}
