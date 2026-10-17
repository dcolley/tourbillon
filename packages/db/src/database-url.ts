/**
 * Defensive handling of DATABASE_URL.
 *
 * The connection string carries credentials, so nothing here may ever echo it back: validation
 * errors use a fixed message plus a short problem code, never the input, and carry no `cause`.
 * (Node's own URL parser attaches the raw input to the TypeError it throws, so its errors must not
 * escape.) This module is pure: it does not import the postgres driver or open a connection, so a
 * process can validate the URL before anything that connects at import time is loaded.
 */

export type DatabaseUrlProblem = 'bad-scheme' | 'unparseable' | 'bad-encoding' | 'bad-port';

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
  let hostPart = raw.slice(raw.indexOf('://') + 3).split(/[?/]/)[0] ?? '';
  try {
    hostPart = decodeURIComponent(hostPart.slice(hostPart.indexOf('@') + 1));
  } catch {
    return 'bad-encoding';
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
  return {
    ...(parsed.username ? { user: parsed.username } : {}),
    ...(parsed.hostname ? { host: parsed.hostname } : {}),
    ...(parsed.port ? { port: parsed.port } : {}),
    ...(parsed.database ? { database: parsed.database } : {}),
  };
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
    // Malformed: still strip whatever sits between "user:" and "@".
    const m = /:\/\/[^:/@]*:([^@]*)@/.exec(raw);
    if (m?.[1]) out.add(m[1]);
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
