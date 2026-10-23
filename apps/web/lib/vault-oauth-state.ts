/**
 * Vault OAuth `state` signing (#112, fail closed).
 *
 * The state round-trips through the OAuth provider, so it is HMAC-SHA256 signed with
 * BETTER_AUTH_SECRET. When that secret is unset or a known public default
 * (`change-me-in-production…`), anyone could forge a state, so there is NO fallback: signing
 * returns null, verification returns false, and both routes refuse the flow. The known-default
 * list is shared with board auth (`isDefaultOrUnsetJwtSecret`, #108).
 *
 * #112 items 3–4: the state is also bound to the browser and the board company. See
 * `buildOAuthState` / `readOAuthState` below.
 *
 * Never log the secret or the state. This module only logs the env var name.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { isDefaultOrUnsetJwtSecret, isInsecureDevBoardAuth, type BoardRequestHeaders } from './board-auth';

export const OAUTH_STATE_SECRET_ENV = 'BETTER_AUTH_SECRET';

/** Query flag used on the /settings redirect when OAuth is refused for a missing secret. */
export const OAUTH_NOT_CONFIGURED_ERROR = 'oauth_state_secret_not_configured';

function oauthStateKey(): string | null {
  if (isDefaultOrUnsetJwtSecret()) return null;
  return process.env[OAUTH_STATE_SECRET_ENV]!.trim();
}

/** True when a real (non-default) secret is configured, so the OAuth flow may run. */
export function isOAuthStateSecretConfigured(): boolean {
  return oauthStateKey() !== null;
}

/** One clear server error naming the env var (never a value). */
export function logOAuthStateSecretMissing(stage: 'start' | 'finish'): void {
  console.error(
    `[vault-oauth] ${OAUTH_STATE_SECRET_ENV} is unset or a known default; refusing to ${stage} the OAuth flow. ` +
      `Set ${OAUTH_STATE_SECRET_ENV} to a real secret (e.g. openssl rand -base64 32).`,
  );
}

/** HMAC-SHA256 hex of the state payload, or null when no real secret is configured. */
export function signOAuthState(payload: string): string | null {
  const key = oauthStateKey();
  if (!key) return null;
  return createHmac('sha256', key).update(payload).digest('hex');
}

/** Constant-time check of a state signature. False when no real secret is configured. */
export function verifyOAuthState(payload: unknown, signature: unknown): boolean {
  if (typeof payload !== 'string' || typeof signature !== 'string') return false;
  const expected = signOAuthState(payload);
  if (!expected) return false;
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * #112 items 3–4: state bound to a browser nonce, the board company and the agent.
 *
 * State (base64 JSON, unchanged envelope): `{ payload, signature }`, where `signature` is the
 * HMAC above and `payload` is JSON
 *   `{ v: 2, serverId, scope, agentId?, companyId, nonce, exp }`
 * - `nonce`: 32 random bytes (base64url). The same value goes into the httpOnly
 *   `tourbillon_vault_oauth_nonce` cookie (Secure except under the loopback-only
 *   TOURBILLON_BOARD_AUTH_INSECURE_DEV opt-in, SameSite=Lax, Path=/api/vault/oauth/callback),
 *   and its SHA-256 is recorded server-side for single use (vault-oauth-nonce-store).
 * - `companyId`: the board company that started the flow; the callback must run under the same.
 * - `exp`: unix seconds, `OAUTH_STATE_TTL_SEC` after authorize.
 * There is no userId: board sessions carry no user identity yet (#107), so user-scoped
 * (`company_user`) grants are refused at both ends instead of trusting an unverifiable id.
 */
export const OAUTH_NONCE_COOKIE = 'tourbillon_vault_oauth_nonce';
export const OAUTH_CALLBACK_PATH = '/api/vault/oauth/callback';
export const OAUTH_STATE_TTL_SEC = 10 * 60;

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

/** Build a signed, bound state. Null when no real secret is configured (fail closed). */
export function buildOAuthState(
  fields: { serverId: string; scope: OAuthStateScope; agentId?: string; companyId: string },
  nowMs: number = Date.now(),
): { state: string; nonce: string; expiresAt: Date } | null {
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
  return { state, nonce, expiresAt: new Date(exp * 1000) };
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
 * Verify a returned state against the nonce cookie: signature (constant time), shape, expiry,
 * then cookie presence and match (constant time). Company / agent ownership and single use are
 * checked by the callback, which has the board session and the DB.
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

/** Nonce cookie attributes. Secure unless the loopback-only insecure-dev opt-in applies. */
export function oauthNonceCookieOptions(headers: BoardRequestHeaders) {
  return {
    httpOnly: true,
    secure: !isInsecureDevBoardAuth(headers),
    sameSite: 'lax' as const,
    path: OAUTH_CALLBACK_PATH,
    maxAge: OAUTH_STATE_TTL_SEC,
  };
}

/** Clear the nonce cookie on a callback response (every outcome). */
export function clearOAuthNonceCookie(res: NextResponse, headers: BoardRequestHeaders): NextResponse {
  res.cookies.set(OAUTH_NONCE_COOKIE, '', { ...oauthNonceCookieOptions(headers), maxAge: 0 });
  return res;
}

/**
 * Redirect to a /settings page with a RELATIVE Location header (RFC 9110 §10.2.2 allows it;
 * browsers resolve it against the URL they requested, i.e. the public origin).
 * Why not an absolute URL: in Next 16 `req.nextUrl.origin` is the address the server was
 * started on (localhost:3002), so behind a TLS proxy every redirect went to localhost; and
 * building from Host / X-Forwarded-Host would let a client pick the redirect origin. A
 * relative path needs no env (BETTER_AUTH_URL) and no request header, so nothing can steer
 * it off-site. NextResponse.redirect rejects relative URLs, hence the raw 307.
 */
export function settingsRedirect(pathAndQuery: string): NextResponse {
  if (!pathAndQuery.startsWith('/settings')) {
    throw new Error('settingsRedirect only redirects within /settings');
  }
  return new NextResponse(null, { status: 307, headers: { Location: pathAndQuery } });
}
