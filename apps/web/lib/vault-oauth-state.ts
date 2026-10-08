/**
 * Vault OAuth `state` signing (#112, fail closed).
 *
 * The state round-trips through the OAuth provider, so it is HMAC-SHA256 signed with
 * BETTER_AUTH_SECRET. When that secret is unset or a known public default
 * (`change-me-in-production…`), anyone could forge a state, so there is NO fallback: signing
 * returns null, verification returns false, and both routes refuse the flow. The known-default
 * list is shared with board auth (`isDefaultOrUnsetJwtSecret`, #108).
 *
 * Never log the secret or the state. This module only logs the env var name.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { isDefaultOrUnsetJwtSecret } from './board-auth';

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
