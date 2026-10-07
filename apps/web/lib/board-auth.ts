/**
 * Board identity (#105, interim until real login in #107).
 *
 * Board = the operator. A request is board only if it carries ONE of:
 *   - a board session cookie (`tourbillon_board_session`): signed, httpOnly, short-lived,
 *     issued by POST /api/board/session after the operator secret is presented; or
 *   - a board JWT (`X-Company-Token`): minted by POST /api/mobile/companies, which now
 *     requires the operator secret in `X-Board-Secret`.
 * The raw `active_company_id` cookie only *selects* a company; it never grants board.
 * A request carrying an agent run/chat token is never board (whatever cookies it sends).
 *
 * Pure module (jose + node:crypto only) so proxy.ts, route handlers and tests can share it.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { validateRunToken } from './auth/run-token';

/** Env var holding the operator secret. Unset → minting/unlock fail closed. */
export const BOARD_SECRET_ENV = 'TOURBILLON_BOARD_SECRET';
/** Request header carrying the operator secret. */
export const BOARD_SECRET_HEADER = 'x-board-secret';
/**
 * Local-dev opt-in: with `TOURBILLON_BOARD_AUTH_INSECURE_DEV=1` and NODE_ENV !== 'production',
 * an unset TOURBILLON_BOARD_SECRET does not fail closed (any non-empty secret is accepted).
 * Ignored in production.
 */
export const BOARD_INSECURE_DEV_ENV = 'TOURBILLON_BOARD_AUTH_INSECURE_DEV';
export const BOARD_SESSION_COOKIE = 'tourbillon_board_session';
export const BOARD_SESSION_TTL_SEC = 12 * 60 * 60;

const SESSION_TYP = 'tourbillon_board_session';
const KNOWN_DEFAULT_JWT_SECRETS = new Set([
  'change-me-in-production',
  'change-me-in-production-use-openssl-rand-base64-32',
]);

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function isInsecureDevBoardAuth(): boolean {
  return !isProduction() && process.env[BOARD_INSECURE_DEV_ENV] === '1';
}

function configuredBoardSecret(): string | null {
  const v = process.env[BOARD_SECRET_ENV]?.trim();
  return v ? v : null;
}

/** True when the operator secret is configured, or local dev explicitly opted out. */
export function isBoardAuthConfigured(): boolean {
  return configuredBoardSecret() !== null || isInsecureDevBoardAuth();
}

/** Constant-time check of a presented operator secret. Fails closed when unconfigured. */
export function verifyOperatorSecret(presented: string | null | undefined): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const expected = configuredBoardSecret();
  // Unset secret: fail closed; local-dev opt-in accepts any non-empty value.
  if (!expected) return isInsecureDevBoardAuth();
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * True when the request carries an agent run/chat token (`Authorization: Bearer pm_run_…|pm_chat_…`).
 * Prefix match on purpose: even a malformed agent token disqualifies the request from board.
 */
export function hasAgentToken(authorization: string | null | undefined): boolean {
  const bearer = authorization?.replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return false;
  return bearer.startsWith('pm_run_') || bearer.startsWith('pm_chat_') || validateRunToken(bearer) !== null;
}

/**
 * Signing key for board JWTs (X-Company-Token). Same secret as before (BETTER_AUTH_SECRET) so
 * existing tokens keep working. In production a missing/known-default secret fails closed:
 * a token signed with a public default string is forgeable by anyone.
 */
export function boardJwtKey(): Uint8Array | null {
  const secret = process.env.BETTER_AUTH_SECRET?.trim();
  if (secret && !(isProduction() && KNOWN_DEFAULT_JWT_SECRETS.has(secret))) {
    return new TextEncoder().encode(secret);
  }
  if (isProduction()) return null;
  return new TextEncoder().encode(secret || 'change-me-in-production');
}

/** Mint a board JWT for a company (30 days, unchanged payload `{ companyId }`). */
export async function mintBoardJwt(companyId: string): Promise<string | null> {
  const key = boardJwtKey();
  if (!key) return null;
  return new SignJWT({ companyId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(key);
}

/** Verify a board JWT; returns its companyId or null. */
export async function verifyBoardJwt(token: string | null | undefined): Promise<string | null> {
  if (!token) return null;
  const key = boardJwtKey();
  if (!key) return null;
  try {
    const { payload } = await jwtVerify(token, key);
    return typeof payload.companyId === 'string' ? payload.companyId : null;
  } catch {
    return null;
  }
}

/**
 * Session-cookie signing key, derived from the operator secret, so rotating
 * TOURBILLON_BOARD_SECRET invalidates every board session.
 */
function boardSessionKey(): Uint8Array | null {
  const secret = configuredBoardSecret() ?? (isInsecureDevBoardAuth() ? 'insecure-dev-board-secret' : null);
  if (!secret) return null;
  return new Uint8Array(createHmac('sha256', 'tourbillon-board-session-v1').update(secret).digest());
}

export async function createBoardSessionToken(): Promise<string | null> {
  const key = boardSessionKey();
  if (!key) return null;
  return new SignJWT({ typ: SESSION_TYP })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${BOARD_SESSION_TTL_SEC}s`)
    .sign(key);
}

export async function verifyBoardSessionToken(token: string | null | undefined): Promise<boolean> {
  if (!token) return false;
  const key = boardSessionKey();
  if (!key) return false;
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
    return payload.typ === SESSION_TYP;
  } catch {
    return false;
  }
}

/** Cookie attributes for the board session (Secure when the request came in over https). */
export function boardSessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/',
    maxAge: BOARD_SESSION_TTL_SEC,
  };
}
