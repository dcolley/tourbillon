import { NextRequest, NextResponse } from 'next/server';
import { db } from '@tourbillon/db';
import { vaultSecrets } from '@tourbillon/db/schema';
import { eq, and } from 'drizzle-orm';
import { encryptCredential } from '@tourbillon/shared/vault-encryption';
import { getActiveCompany } from '@/lib/company';
import type { OAuthTokens } from '@tourbillon/db/schema';
import {
  OAUTH_NOT_CONFIGURED_ERROR,
  isOAuthStateSecretConfigured,
  logOAuthStateSecretMissing,
  verifyOAuthState,
} from '@/lib/vault-oauth-state';

/**
 * NextResponse.redirect needs an absolute URL (relative paths throw → 500). Always lands on
 * /settings of the request's own origin, so this is not an open redirect.
 */
function settingsRedirect(req: NextRequest, pathAndQuery: string): NextResponse {
  return NextResponse.redirect(new URL(pathAndQuery, req.nextUrl.origin));
}

export async function GET(req: NextRequest) {
  // #112: fail closed. Without a real BETTER_AUTH_SECRET no state can be trusted.
  if (!isOAuthStateSecretConfigured()) {
    logOAuthStateSecretMissing('finish');
    return settingsRedirect(req, `/settings?oauth_error=${OAUTH_NOT_CONFIGURED_ERROR}`);
  }

  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');
    
    if (error) {
      return settingsRedirect(req, `/settings?oauth_error=${encodeURIComponent(error)}`);
    }
    
    if (!code || !state) {
      return settingsRedirect(req, '/settings?oauth_error=missing_parameters');
    }
    
    let stateData: { payload: string; signature: string };
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
    } catch {
      return settingsRedirect(req, '/settings?oauth_error=invalid_state');
    }
    
    if (!verifyOAuthState(stateData.payload, stateData.signature)) {
      return settingsRedirect(req, '/settings?oauth_error=invalid_state_signature');
    }
    
    const { serverId, scope, userId, agentId } = JSON.parse(stateData.payload);
    
    const company = await getActiveCompany();
    
    if (serverId === 'github-mcp') {
      const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
      const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
      
      if (!clientId || !clientSecret) {
        return settingsRedirect(req, '/settings?oauth_error=not_configured');
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
        return settingsRedirect(req, '/settings?oauth_error=token_exchange_failed');
      }
      
      const tokenData = await tokenResponse.json();
      
      if (tokenData.error) {
        return settingsRedirect(req, `/settings?oauth_error=${encodeURIComponent(tokenData.error)}`);
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
      
      if (scope === 'company_user' && userId) {
        conditions.push(eq(vaultSecrets.userId, userId));
      }
      
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
          userId,
          agentId,
          authType: 'oauth',
          encryptedValue,
          needsReauth: false,
        });
      }
      
      return settingsRedirect(req, `/settings?connected=${serverId}`);
    }
    
    return settingsRedirect(req, '/settings?oauth_error=unsupported_provider');
  } catch (error) {
    console.error('Error in OAuth callback:', error);
    return settingsRedirect(req, '/settings?oauth_error=callback_failed');
  }
}
