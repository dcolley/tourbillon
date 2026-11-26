/**
 * TB-364 (A26, normative name): the single redactor for provider/engine error text before it
 * leaves the server or is stored. Server-side use is mandatory (SSE RUN_ERROR, stored marker
 * attribute, logs); the client re-applies it defensively so a stored legacy raw string still
 * renders redacted.
 *
 * Rules:
 * - No secret may survive: Authorization/Bearer headers, sk-live-/sk-test-/sk-proj- keys,
 *   api_key= / apikey= / x-api-key / access_token / token values, ?key= query params, JWTs
 *   (eyJ... segments), URL user:pass@ credentials, and Test's «redacted:...» placeholders.
 * - S5 (soft): RFC1918/loopback addresses and internal hostnames are redacted in the technical
 *   text too. Model-group names (spark1/inkling-2-mini style) are ALLOWED (PM ruling: Derek must
 *   be able to see which model group failed).
 * - Bounded: output is capped at TECHNICAL_MAX_CHARS with a visible truncation marker.
 * - No catastrophic backtracking: every pattern is linear (character classes with a single
 *   unbounded tail; no nested quantifiers). A 1 MB hostile string must process in well under
 *   200 ms (A26 perf cell).
 */

export const TECHNICAL_MAX_CHARS = 2000;
const TRUNCATION_MARKER = '…[truncated]';

/** One pass per rule; all linear-time. */
const SECRET_RULES: Array<{ re: RegExp; to: string }> = [
  // Authorization: Bearer <token> (and bare Bearer <token>).
  { re: /\bBearer\s+[A-Za-z0-9._~+\/=-]{4,}/gi, to: 'Bearer [redacted]' },
  // Provider keys: sk-live-…, sk-test-…, sk-proj-…, sk-… of any length.
  { re: /\bsk-(?:live|test|proj|ant|api)?-?[A-Za-z0-9_-]{4,}/g, to: 'sk-[redacted]' },
  // key=value pairs whose name reads like a credential (api_key=…, x-api-key: …, token=…).
  {
    re: /\b(api[_-]?key|x-api-key|apikey|access_token|auth_token|token|secret|password)\b\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;&}'\]]{4,})/gi,
    to: '$1=[redacted]',
  },
  // ?key=… / &key=… query params.
  { re: /([?&](?:key|api_key|access_token|token)=)[^\s&]+/gi, to: '$1[redacted]' },
  // JWTs: three base64url segments starting with eyJ.
  { re: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, to: '[jwt-redacted]' },
  // URL credentials: scheme://user:password@host.
  { re: /\b(https?:\/\/)[^\s\/@\s]+:[^\s\/@\s]+@/gi, to: '$1[redacted]@' },
  // Test's scrubbed-secret placeholder convention («redacted:…» / «secret:…»).
  { re: /\u00ab(?:redacted|secret)[^>\u00bb]*\u00bb/gi, to: '[redacted]' },
  // Runs of asterisks standing in for a secret.
  { re: /\*{3,}/g, to: '[redacted]' },
];

/** S5: infrastructure redaction (credential redaction above is MUST A26; this is SHOULD S5). */
const INFRA_RULES: Array<{ re: RegExp; to: string }> = [
  // RFC1918 + loopback IPv4.
  {
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g,
    to: '[internal-ip]',
  },
  // Internal hostnames (Mac home hosts, .local/.internal/.lan/.corp).
  { re: /\b[\w-]+(?:\.[\w-]+)*\.(?:local|internal|lan|corp)\b/gi, to: '[internal-host]' },
];

/**
 * Redact secrets (A26) and infrastructure (S5) from raw provider/engine text and bound it to
 * ≤ TECHNICAL_MAX_CHARS. Never throws: a non-string yields a stable neutral line.
 */
export function redactErrorText(text: string, opts: { redactInfra?: boolean } = {}): string {
  let out = typeof text === 'string' ? text : String(text ?? '');
  for (const rule of SECRET_RULES) out = out.replace(rule.re, rule.to);
  if (opts.redactInfra !== false) {
    for (const rule of INFRA_RULES) out = out.replace(rule.re, rule.to);
  }
  // Control characters have no place in technical details.
  out = out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  if (out.length > TECHNICAL_MAX_CHARS) {
    out = `${out.slice(0, TECHNICAL_MAX_CHARS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
  }
  return out;
}
