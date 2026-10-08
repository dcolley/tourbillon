/**
 * HITLy resume credential: generated per forwarded approval, stored only as a SHA-256 digest
 * bound to the approval id, compared in constant time, single-use and time-limited.
 *
 * Transport: HITLy's `http` plugin POSTs the decision to the `resumeUrl` it was given at
 * ingest with no extra headers or signature, so the credential travels in that URL
 * (`?token=`). A `X-Hitly-Resume-Token` header is also accepted (and preferred) so the
 * transport can move out of the URL once HITLy can send it.
 *
 * The resume route is for HITLy only: requests carrying any Tourbillon credential (agent
 * run/chat token, company token, board session) are refused before the token is looked at.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const RESUME_TOKEN_HEADER = 'x-hitly-resume-token';
export const RESUME_TOKEN_QUERY_PARAM = 'token';
/** How long a resume link stays valid after the approval is forwarded. */
export const RESUME_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Upper bound on an accepted token's length (ours are 43 chars). */
const MAX_TOKEN_CHARS = 256;

export function generateResumeToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Hex SHA-256 over a versioned, approval-bound message. */
export function hashResumeToken(approvalId: string, token: string): string {
  return createHash('sha256').update(`hitly-resume:v1:${approvalId}:${token}`).digest('hex');
}

export function resumeTokenExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + RESUME_TOKEN_TTL_MS);
}

/** Constant-time check of `token` against the stored digest for `approvalId`. */
export function resumeTokenMatches(approvalId: string, token: string, storedHash: string | null | undefined): boolean {
  if (typeof storedHash !== 'string' || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const expected = Buffer.from(storedHash, 'hex');
  const actual = Buffer.from(hashResumeToken(approvalId, token), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Headers that carry a Tourbillon credential; HITLy's resume callback never sends them. */
const TOURBILLON_CREDENTIAL_HEADERS = ['authorization', 'x-company-token'];
/** Cookies that carry a Tourbillon session (BOARD_SESSION_COOKIE in board-auth). */
const TOURBILLON_SESSION_COOKIES = ['tourbillon_board_session'];

function hasTourbillonCredential(headers: Headers): boolean {
  if (TOURBILLON_CREDENTIAL_HEADERS.some((h) => (headers.get(h) ?? '').trim() !== '')) return true;
  const cookie = headers.get('cookie') ?? '';
  return TOURBILLON_SESSION_COOKIES.some((name) =>
    cookie.split(';').some((part) => part.trim().startsWith(`${name}=`)),
  );
}

export type ResumeCredential =
  | { ok: true; token: string; source: 'header' | 'query' }
  | { ok: false; status: number; error: string };

/**
 * Read the resume credential from a request: refuses Tourbillon credentials, prefers the
 * header, falls back to the query parameter, refuses a header/query mismatch.
 */
export function readResumeCredential(req: { headers: Headers; url: string }): ResumeCredential {
  if (hasTourbillonCredential(req.headers)) {
    return { ok: false, status: 403, error: 'This endpoint only accepts HITLy resume callbacks' };
  }
  const header = (req.headers.get(RESUME_TOKEN_HEADER) ?? '').trim();
  let query = '';
  try {
    query = (new URL(req.url).searchParams.get(RESUME_TOKEN_QUERY_PARAM) ?? '').trim();
  } catch {
    query = '';
  }
  if (header && query && header !== query) {
    return { ok: false, status: 400, error: 'Conflicting resume tokens' };
  }
  const token = header || query;
  if (!token) return { ok: false, status: 401, error: 'Missing resume token' };
  if (token.length > MAX_TOKEN_CHARS) return { ok: false, status: 401, error: 'Invalid resume token' };
  return { ok: true, token, source: header ? 'header' : 'query' };
}
