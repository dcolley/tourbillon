import type { NextRequest, NextResponse } from 'next/server';
import { db, agents } from '@tourbillon/db';
import { vaultSecrets } from '@tourbillon/db/schema';
import { eq, and } from 'drizzle-orm';
import { encryptCredential } from '@tourbillon/shared/vault-encryption';
import { requireBoardCompany } from '@/lib/board-route-auth';
import type { OAuthTokens } from '@tourbillon/db/schema';
import {
  OAUTH_NONCE_COOKIE,
  OAUTH_NOT_CONFIGURED_ERROR,
  clearOAuthNonceCookie,
  isOAuthStateSecretConfigured,
  logOAuthStateSecretMissing,
  readOAuthState,
  settingsRedirect,
} from '@/lib/vault-oauth-state';
import { consumeOAuthNonce } from '@/lib/vault-oauth-nonce-store';

/**
 * GET /api/vault/oauth/callback
 *
 * #112 items 3–4: before any token exchange the state must
 *   1. carry a valid signature (constant time) and an unexpired `exp`;
 *   2. match the httpOnly nonce cookie set by authorize (constant time);
 *   3. come back under a board session for the SAME company it was issued for;
 *   4. name an agent (agent scope) that belongs to that company; user-scoped grants are refused
 *      (board sessions carry no user identity yet, #107);
 *   5. redeem its nonce server-side exactly once (replay → state_already_used).
 * Any failure redirects to /settings?oauth_error=<code> (or the board guard's 401/403) with no
 * token exchange. The nonce cookie is cleared on every outcome.
 */
export async function GET(req: NextRequest) {
  const res = await handleCallback(req);
  return clearOAuthNonceCookie(res, req.headers);
}

async function handleCallback(req: NextRequest): Promise<NextResponse> {
  // #112: fail closed. Without a real BETTER_AUTH_SECRET no state can be trusted.
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
    
    const checked = readOAuthState(state, req.cookies.get(OAUTH_NONCE_COOKIE)?.value);
    if (!checked.ok) {
      return settingsRedirect(`/settings?oauth_error=${checked.error}`);
    }
    const { serverId, scope, agentId, companyId, nonce } = checked.value;

    // Board only, and the same company that started the flow.
    const auth = await requireBoardCompany(req);
    if (!auth.ok) return auth.response;
    const company = auth.value;
    if (companyId !== company.id) {
      return settingsRedirect('/settings?oauth_error=company_mismatch');
    }

    if (scope === 'company_user') {
      return settingsRedirect('/settings?oauth_error=user_scope_unsupported');
    }
    if ((scope === 'agent') !== Boolean(agentId)) {
      return settingsRedirect('/settings?oauth_error=invalid_state');
    }
    if (agentId) {
      const agent = await db.query.agents.findFirst({
        where: and(eq(agents.id, agentId), eq(agents.companyId, company.id)),
      });
      if (!agent) {
        return settingsRedirect('/settings?oauth_error=agent_not_in_company');
      }
    }

    // Single use: atomically redeem the nonce recorded at authorize.
    if (!(await consumeOAuthNonce(nonce))) {
      return settingsRedirect('/settings?oauth_error=state_already_used');
    }
    
    if (serverId === 'github-mcp') {
      const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
      const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
      
      if (!clientId || !clientSecret) {
        return settingsRedirect('/settings?oauth_error=not_configured');
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
      
      const tokenData = await tokenResponse.json();
      
      if (tokenData.error) {
        return settingsRedirect(`/settings?oauth_error=${encodeURIComponent(tokenData.error)}`);
      }
      
      const tokens: OAuthTokens = {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: tokenData.expires_in 
          ? Date.now() + tokenData.expires_in * 1000 
          : undefined,
        scope: tokenData.scope,
      };
      
      const encryptedValue = encryptCredential(tokens);
      
      const conditions = [
        eq(vaultSecrets.companyId, company.id),
        eq(vaultSecrets.serverId, serverId),
        eq(vaultSecrets.scope, scope),
      ];
      
      if (scope === 'agent' && agentId) {
        conditions.push(eq(vaultSecrets.agentId, agentId));
      }
      
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
      
      return settingsRedirect(`/settings?connected=${encodeURIComponent(serverId)}`);
    }
    
    return settingsRedirect('/settings?oauth_error=unsupported_provider');
  } catch (error) {
    console.error('Error in OAuth callback:', error);
    return settingsRedirect('/settings?oauth_error=callback_failed');
  }
}
