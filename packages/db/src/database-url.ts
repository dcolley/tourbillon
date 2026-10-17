/**
 * Defensive handling of DATABASE_URL.
 *
 * The connection string carries credentials, so nothing here may ever echo it back: validation
 * errors use a fixed message plus a short problem code, never the input, and carry no `cause`.
 * (Node's own URL parser attaches the raw input to the TypeError it throws, so its errors must not
 * escape.) This module is pure: it does not import the postgres driver or open a connection, so a
 * process can validate the URL before anything that connects at import time is loaded.
 */

export type DatabaseUrlProblem =
  | 'bad-scheme'
  | 'unparseable'
  | 'bad-encoding'
  | 'bad-port'
  | 'ambiguous-authority';

export const DATABASE_URL_INVALID_CODE = 'DATABASE_URL_INVALID';

export class DatabaseUrlError extends Error {
  readonly code = DATABASE_URL_INVALID_CODE;

  constructor(readonly problem: DatabaseUrlProblem) {
    super(`DATABASE_URL is not a valid postgres connection URL (${problem})`);
    this.name = 'DatabaseUrlError';
  }
}

interface ParsedDatabaseUrl {
  username: string;
  password: string;
  hostname: string;
  port: string;
  database: string;
}

/**
 * Parse the way postgres-js does (multi-host aware), but inside try/catch so a malformed value
 * becomes a problem code instead of a driver/URL error that carries the raw string.
 */
function parseDatabaseUrl(raw: string): ParsedDatabaseUrl | DatabaseUrlProblem {
  if (!/^postgres(?:ql)?:\/\//i.test(raw)) return 'bad-scheme';
  // Reserved characters in userinfo must be percent-encoded. When they are not, parsers disagree on
  // where the credentials end, so refuse anything where that boundary is not unambiguous: an '@'
  // after the authority (in path, query or fragment), or more than one '@' in it.
  const afterScheme = raw.slice(raw.indexOf('://') + 3);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  const rest = authorityEnd === -1 ? '' : afterScheme.slice(authorityEnd);
  if (rest.includes('@') || authority.split('@').length > 2) return 'ambiguous-authority';
  let hostPart = raw.slice(raw.indexOf('://') + 3).split(/[?/]/)[0] ?? '';
  try {
    hostPart = decodeURIComponent(hostPart.slice(hostPart.indexOf('@') + 1));
  } catch {
    return 'bad-encoding';
  }
  if (hostPart.includes('@')) return 'ambiguous-authority';
  // Every host of a multi-host list, not just the first (which is all WHATWG URL sees).
  if (hostPart) {
    for (const entry of hostPart.split(',')) {
      const m = /^(\[[^\]]*\]|[^:[\]]+)(?::([^:]*))?$/.exec(entry);
      if (!m) return 'unparseable';
      if (m[2] !== undefined) {
        if (!/^\d{1,5}$/.test(m[2])) return 'bad-port';
        const port = Number(m[2]);
        if (port < 1 || port > 65535) return 'bad-port';
      }
    }
  }
  let url: URL;
  try {
    url = new URL(raw.replace(hostPart, hostPart.split(',')[0] ?? ''));
  } catch {
    return 'unparseable';
  }
  let username: string;
  let password: string;
  let database: string;
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    return 'bad-encoding';
  }
  if (url.port) {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'bad-port';
  }
  return { username, password, hostname: url.hostname, port: url.port, database };
}

/** Problem code for a malformed URL, or null when it is usable (or unset: drivers fall back to PG* env). */
export function checkDatabaseUrl(raw: string | undefined): DatabaseUrlProblem | null {
  if (raw === undefined || raw === '') return null;
  const parsed = parseDatabaseUrl(raw);
  return typeof parsed === 'string' ? parsed : null;
}

/** Throw a DatabaseUrlError (fixed message, no input, no cause) when DATABASE_URL is malformed. */
export function assertValidDatabaseUrl(raw: string | undefined): void {
  const problem = checkDatabaseUrl(raw);
  if (problem) throw new DatabaseUrlError(problem);
}

/** DATABASE_URL for a store that needs one: required, and validated without echoing it. */
export function requireDatabaseUrl(purpose: string, raw = process.env.DATABASE_URL): string {
  if (!raw) throw new Error(`DATABASE_URL is required for ${purpose}`);
  assertValidDatabaseUrl(raw);
  return raw;
}

/** Non-secret parts of the URL (user, host, port, database) for logs. Never the password. */
export function describeDatabaseTarget(
  raw: string | undefined = process.env.DATABASE_URL,
): { user?: string; host?: string; port?: string; database?: string } | null {
  if (!raw) return null;
  const parsed = parseDatabaseUrl(raw);
  if (typeof parsed === 'string') return null;
  return safeTargetFields(
    { user: parsed.username, host: parsed.hostname, port: parsed.port, database: parsed.database },
    secretFragments(raw).filter((fragment) => fragment !== raw),
  );
}

/**
 * Defence in depth for describeDatabaseTarget: drop any field that contains '@' (a sign the
 * credentials boundary was misread) or any password fragment. Exported for tests.
 */
export function safeTargetFields(
  fields: Record<'user' | 'host' | 'port' | 'database', string>,
  secrets: string[],
): { user?: string; host?: string; port?: string; database?: string } {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!value || value.includes('@')) continue;
    if (secrets.some((secret) => value.includes(secret) || (value.length >= 3 && secret.includes(value)))) continue;
    out[key] = value;
  }
  return out;
}

const REDACTED = '[redacted]';
/** Any scheme://…@… token: a URL with userinfo, whatever DATABASE_URL currently says. */
const URL_WITH_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]*@[^\s'"<>]*/gi;
const PASSWORD_PARAM = /(password\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;
const MAX_MESSAGE_LENGTH = 300;

function secretFragments(raw: string | undefined): string[] {
  if (!raw) return [];
  const out = new Set<string>([raw]);
  const parsed = parseDatabaseUrl(raw);
  if (typeof parsed !== 'string' && parsed.password) {
    out.add(parsed.password);
    out.add(encodeURIComponent(parsed.password));
  } else {
    // Malformed or ambiguous: strip whatever sits between "user:" and the first '@', and between
    // "user:" and the last '@' (an unencoded '@' or '/' can sit inside the password).
    const first = /:\/\/[^:/@]*:([^@]*)@/.exec(raw);
    if (first?.[1]) out.add(first[1]);
    const last = /:\/\/[^:/@]*:(.*)@/.exec(raw);
    if (last?.[1]) out.add(last[1]);
  }
  // Very short passwords are not redacted as substrings (they would shred the message); the
  // URL-with-userinfo pattern below still catches them inside any echoed URL.
  return [...out].filter((s) => s === raw || s.length >= 3).sort((a, b) => b.length - a.length);
}

/** Remove the URL, its password and any URL-with-credentials or password=… from free text. */
export function sanitizeDbErrorText(text: string, raw: string | undefined = process.env.DATABASE_URL): string {
  let out = text;
  for (const fragment of secretFragments(raw)) out = out.split(fragment).join(REDACTED);
  out = out.replace(URL_WITH_USERINFO, REDACTED).replace(PASSWORD_PARAM, `$1${REDACTED}`);
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > MAX_MESSAGE_LENGTH ? `${out.slice(0, MAX_MESSAGE_LENGTH)}…` : out;
}

function errorChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur !== undefined && cur !== null; depth += 1) {
    chain.push(cur);
    if (typeof cur !== 'object') break;
    const rec = cur as { cause?: unknown; errors?: unknown };
    if (rec.cause !== undefined) cur = rec.cause;
    else if (Array.isArray(rec.errors) && rec.errors.length > 0) cur = rec.errors[0];
    else break;
  }
  return chain;
}

/**
 * Message and code of the underlying error, sanitised. drizzle wraps driver errors as
 * "Failed query: select 1 params:" with the real reason (refused, auth failed, missing database)
 * in `cause`, so prefer the innermost message and code.
 * Only message text and a code string leave this function: no stack, no other fields.
 */
export function describeDbError(
  err: unknown,
  raw: string | undefined = process.env.DATABASE_URL,
): { message: string; code?: string } {
  const chain = errorChain(err);
  let message = '';
  let code: string | undefined;
  for (const link of chain) {
    if (link instanceof Error || (typeof link === 'object' && link !== null)) {
      const rec = link as { message?: unknown; code?: unknown };
      if (typeof rec.message === 'string' && rec.message.trim()) message = rec.message;
      if (typeof rec.code === 'string' && rec.code) code = rec.code;
    } else if (typeof link === 'string' && link.trim()) {
      message = link;
    }
  }
  if (!message) message = 'unknown database error';
  const safeCode = code && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : undefined;
  return { message: sanitizeDbErrorText(message, raw), ...(safeCode ? { code: safeCode } : {}) };
}
