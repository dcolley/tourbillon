import type { NextRequest } from 'next/server';
import { db, agents } from '@tourbillon/db';
import { vaultSecrets } from '@tourbillon/db/schema';
import { eq, and } from 'drizzle-orm';
import { encryptCredential } from '@tourbillon/shared/vault-encryption';
import { requireBoardCompany } from '@/lib/board-route-auth';
import type { OAuthTokens } from '@tourbillon/db/schema';
import {
  OAUTH_NOT_CONFIGURED_ERROR,
  USER_SCOPE_UNSUPPORTED_ERROR,
  isOAuthStateSecretConfigured,
  logOAuthStateSecretMissing,
  oauthNonceCookieName,
  readOAuthState,
  settingsRedirect,
} from '@/lib/vault-oauth-state';
import { consumeOAuthNonce } from '@/lib/vault-oauth-nonce-store';

/**
 * Consume/cleanup order (#112 case 9):
 *  1. Secret configured? else oauth_state_secret_not_configured — NO consume, NO cookie Set-Cookie.
 *  2. Provider `error` query → encoded error — NO consume.
 *  3. Missing code/state → missing_parameters — NO consume.
 *  4. readOAuthState → invalid_state | invalid_state_signature | state_expired | missing_nonce |
 *     nonce_mismatch — NO consume. Callback NEVER emits nonce Set-Cookie.
 *  5. requireBoardCompany → 401/403 — NO consume.
 *  6. company_mismatch — NO consume.
 *  7. company_user → user_scope_unsupported — NO consume.
 *  8. agent missing/other company/archived → agent_not_in_company — NO consume.
 *  9. unsupported_provider / not_configured (GitHub client id/secret) — NO consume (before claim).
 * 10. consumeOAuthNonce — state_already_used if false; DB error → callback_failed, NO exchange.
 * 11. Provider exchange — token_exchange_failed / provider error body; state spent; fresh authorize.
 * 12. encryptCredential / vault write — callback_failed; state spent; fresh authorize.
 * 13. Success → connected=; state spent; no cookie clear.
 */
export async function GET(req: NextRequest) {
  if (!isOAuthStateSecretConfigured()) {
    logOAuthStateSecretMissing('finish');
    return settingsRedirect(`/settings?oauth_error=${OAUTH_NOT_CONFIGURED_ERROR}`);
  }

  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
      return settingsRedirect(`/settings?oauth_error=${encodeURIComponent(error)}`);
    }

    if (!code || !state) {
      return settingsRedirect('/settings?oauth_error=missing_parameters');
    }

    let companyIdHint: string | undefined;
    try {
      const envelope = JSON.parse(Buffer.from(state, 'base64').toString('utf8')) as {
        payload?: string;
      };
      if (typeof envelope.payload === 'string') {
        const body = JSON.parse(envelope.payload) as { companyId?: string };
        if (typeof body.companyId === 'string') companyIdHint = body.companyId;
      }
    } catch {
      return settingsRedirect('/settings?oauth_error=invalid_state');
    }

    const nonceCookie = companyIdHint
      ? req.cookies.get(oauthNonceCookieName(companyIdHint))?.value
      : undefined;

    const checked = readOAuthState(state, nonceCookie);
    if (!checked.ok) {
      return settingsRedirect(`/settings?oauth_error=${checked.error}`);
    }
    const { serverId, scope, agentId, companyId, nonce } = checked.value;

    const auth = await requireBoardCompany(req);
    if (!auth.ok) return auth.response;
    const company = auth.value;
    if (companyId !== company.id) {
      return settingsRedirect('/settings?oauth_error=company_mismatch');
    }

    if (scope === 'company_user') {
      return settingsRedirect(`/settings?oauth_error=${USER_SCOPE_UNSUPPORTED_ERROR}`);
    }
    if ((scope === 'agent') !== Boolean(agentId)) {
      return settingsRedirect('/settings?oauth_error=invalid_state');
    }
    if (agentId) {
      const agent = await db.query.agents.findFirst({
        where: and(eq(agents.id, agentId), eq(agents.companyId, company.id)),
      });
      if (!agent || agent.status === 'archived') {
        return settingsRedirect('/settings?oauth_error=agent_not_in_company');
      }
    }

    // Config / provider gate BEFORE consume (M2) — misconfig must not burn states.
    if (serverId !== 'github-mcp') {
      return settingsRedirect('/settings?oauth_error=unsupported_provider');
    }
    const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return settingsRedirect('/settings?oauth_error=not_configured');
    }

    let consumed = false;
    try {
      consumed = await consumeOAuthNonce(nonce);
    } catch {
      return settingsRedirect('/settings?oauth_error=callback_failed');
    }
    if (!consumed) {
      return settingsRedirect('/settings?oauth_error=state_already_used');
    }

    const baseUrl = process.env.BETTER_AUTH_URL || 'http://localhost:3002';
    const redirectUri = `${baseUrl}/api/vault/oauth/callback`;

    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      return settingsRedirect('/settings?oauth_error=token_exchange_failed');
    }

    const tokenData = (await tokenResponse.json()) as {
      error?: string;
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };

    if (tokenData.error || !tokenData.access_token) {
      return settingsRedirect(
        `/settings?oauth_error=${encodeURIComponent(tokenData.error || 'token_exchange_failed')}`,
      );
    }

    const tokens: OAuthTokens = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : undefined,
      scope: tokenData.scope,
    };

    let encryptedValue: string;
    try {
      encryptedValue = encryptCredential(tokens);
    } catch {
      return settingsRedirect('/settings?oauth_error=callback_failed');
    }

    const conditions = [
      eq(vaultSecrets.companyId, company.id),
      eq(vaultSecrets.serverId, serverId),
      eq(vaultSecrets.scope, scope),
    ];
    if (scope === 'agent' && agentId) {
      conditions.push(eq(vaultSecrets.agentId, agentId));
    }

    try {
      const existing = await db.query.vaultSecrets.findFirst({
        where: and(...conditions),
      });

      if (existing) {
        await db
          .update(vaultSecrets)
          .set({
            authType: 'oauth',
            encryptedValue,
            needsReauth: false,
            updatedAt: new Date(),
          })
          .where(eq(vaultSecrets.id, existing.id));
      } else {
        await db.insert(vaultSecrets).values({
          companyId: company.id,
          serverId,
          scope,
          agentId,
          authType: 'oauth',
          encryptedValue,
          needsReauth: false,
        });
      }
    } catch {
      return settingsRedirect('/settings?oauth_error=callback_failed');
    }

    return settingsRedirect(`/settings?connected=${encodeURIComponent(serverId)}`);
  } catch (error) {
    console.error('Error in OAuth callback:', error);
    return settingsRedirect('/settings?oauth_error=callback_failed');
  }
}
