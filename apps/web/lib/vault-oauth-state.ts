/**
 * Vault OAuth `state` signing and browser+company binding (#112).
 *
 * HMAC key is derived: HMAC-SHA256(BETTER_AUTH_SECRET, "tourbillon-vault-oauth-state-v2").
 * Unset/known-default secret → fail closed (no fallback). Verification uses timingSafeEqual
 * with a length pre-check. State v2 binds nonce + companyId + exp (max 600s); the nonce also
 * lives in an httpOnly cookie named per company so newest-wins cannot cross companies.
 *
 * Callback NEVER clears the nonce cookie (delayed-response race: Set-Cookie applies on arrival).
 * Single-use is the durable verification-table consume only.
 *
 * Never log the secret, state, or cookie value. This module only logs the env var name.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { isDefaultOrUnsetJwtSecret, isInsecureDevBoardAuth, type BoardRequestHeaders } from './board-auth';

export const OAUTH_STATE_SECRET_ENV = 'BETTER_AUTH_SECRET';
export const OAUTH_STATE_KEY_INFO = 'tourbillon-vault-oauth-state-v2';
export const OAUTH_NOT_CONFIGURED_ERROR = 'oauth_state_secret_not_configured';
export const OAUTH_CALLBACK_PATH = '/api/vault/oauth/callback';
export const OAUTH_STATE_TTL_SEC = 10 * 60;
export const OAUTH_NONCE_COOKIE_PREFIX = 'tourbillon_vault_oauth_nonce.';

/** Neutral copy for NEW company_user OAuth without an authenticated user identity. */
export const USER_SCOPE_UNSUPPORTED_MESSAGE =
  'Personal (user-scope) connections are not supported yet. Use a company or agent connection.';
export const USER_SCOPE_UNSUPPORTED_ERROR = 'user_scope_unsupported';

export type OAuthStateScope = 'company' | 'company_user' | 'agent';

export interface OAuthStatePayload {
  v: 2;
  serverId: string;
  scope: OAuthStateScope;
  agentId?: string;
  companyId: string;
  nonce: string;
  exp: number;
}

export type OAuthStateError =
  | 'invalid_state'
  | 'invalid_state_signature'
  | 'state_expired'
  | 'missing_nonce'
  | 'nonce_mismatch';

function oauthStateKey(): Buffer | null {
  if (isDefaultOrUnsetJwtSecret()) return null;
  const secret = process.env[OAUTH_STATE_SECRET_ENV]!.trim();
  return createHmac('sha256', secret).update(OAUTH_STATE_KEY_INFO).digest();
}

export function isOAuthStateSecretConfigured(): boolean {
  return oauthStateKey() !== null;
}

export function logOAuthStateSecretMissing(stage: 'start' | 'finish'): void {
  console.error(
    `[vault-oauth] ${OAUTH_STATE_SECRET_ENV} is unset or a known default; refusing to ${stage} the OAuth flow. ` +
      `Set ${OAUTH_STATE_SECRET_ENV} to a real secret (e.g. openssl rand -base64 32).`,
  );
}

/** Company-scoped cookie name so newest-wins cannot invalidate another company's flow. */
export function oauthNonceCookieName(companyId: string): string {
  return `${OAUTH_NONCE_COOKIE_PREFIX}${companyId}`;
}

export function signOAuthState(payload: string): string | null {
  const key = oauthStateKey();
  if (!key) return null;
  return createHmac('sha256', key).update(payload).digest('hex');
}

export function verifyOAuthState(payload: unknown, signature: unknown): boolean {
  if (typeof payload !== 'string' || typeof signature !== 'string') return false;
  const expected = signOAuthState(payload);
  if (!expected) return false;
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildOAuthState(
  fields: { serverId: string; scope: OAuthStateScope; agentId?: string; companyId: string },
  nowMs: number = Date.now(),
): { state: string; nonce: string; expiresAt: Date; companyId: string } | null {
  const nonce = randomBytes(32).toString('base64url');
  const exp = Math.floor(nowMs / 1000) + OAUTH_STATE_TTL_SEC;
  const body: OAuthStatePayload = {
    v: 2,
    serverId: fields.serverId,
    scope: fields.scope,
    ...(fields.agentId ? { agentId: fields.agentId } : {}),
    companyId: fields.companyId,
    nonce,
    exp,
  };
  const payload = JSON.stringify(body);
  const signature = signOAuthState(payload);
  if (!signature) return null;
  const state = Buffer.from(JSON.stringify({ payload, signature })).toString('base64');
  return { state, nonce, expiresAt: new Date(exp * 1000), companyId: fields.companyId };
}

function isStatePayload(v: unknown): v is OAuthStatePayload {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    p.v === 2 &&
    typeof p.serverId === 'string' &&
    (p.scope === 'company' || p.scope === 'company_user' || p.scope === 'agent') &&
    (p.agentId === undefined || (typeof p.agentId === 'string' && p.agentId.length > 0)) &&
    typeof p.companyId === 'string' &&
    p.companyId.length > 0 &&
    typeof p.nonce === 'string' &&
    p.nonce.length > 0 &&
    typeof p.exp === 'number' &&
    Number.isFinite(p.exp)
  );
}

function sameNonce(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Verify returned state against the company-scoped nonce cookie.
 * Company/agent ownership and single-use are checked by the callback (board session + DB).
 * Zero clock skew: nowSec >= exp → state_expired.
 */
export function readOAuthState(
  state: string,
  nonceCookie: string | null | undefined,
  nowMs: number = Date.now(),
): { ok: true; value: OAuthStatePayload } | { ok: false; error: OAuthStateError } {
  let envelope: unknown;
  try {
    envelope = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
  } catch {
    return { ok: false, error: 'invalid_state' };
  }
  if (!envelope || typeof envelope !== 'object') return { ok: false, error: 'invalid_state' };
  const { payload, signature } = envelope as { payload?: unknown; signature?: unknown };
  if (!verifyOAuthState(payload, signature)) return { ok: false, error: 'invalid_state_signature' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload as string);
  } catch {
    return { ok: false, error: 'invalid_state' };
  }
  if (!isStatePayload(parsed)) return { ok: false, error: 'invalid_state' };
  if (Math.floor(nowMs / 1000) >= parsed.exp) return { ok: false, error: 'state_expired' };
  if (!nonceCookie) return { ok: false, error: 'missing_nonce' };
  if (!sameNonce(nonceCookie, parsed.nonce)) return { ok: false, error: 'nonce_mismatch' };
  return { ok: true, value: parsed };
}

export function oauthNonceCookieOptions(headers: BoardRequestHeaders) {
  return {
    httpOnly: true,
    secure: !isInsecureDevBoardAuth(headers),
    sameSite: 'lax' as const,
    path: OAUTH_CALLBACK_PATH,
    maxAge: OAUTH_STATE_TTL_SEC,
  };
}

/**
 * Redirect to /settings with a RELATIVE Location (RFC 9110 §10.2.2).
 * Never builds an origin from Host / X-Forwarded-Host / nextUrl.origin.
 */
export function settingsRedirect(pathAndQuery: string): NextResponse {
  if (!pathAndQuery.startsWith('/settings')) {
    throw new Error('settingsRedirect only redirects within /settings');
  }
  return new NextResponse(null, { status: 307, headers: { Location: pathAndQuery } });
}
