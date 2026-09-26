import { NextRequest, NextResponse } from 'next/server';
import { db } from '@tourbillon/db';
import { vaultSecrets } from '@tourbillon/db/schema';
import { eq, and } from 'drizzle-orm';
import { encryptCredential } from '@tourbillon/shared/vault-encryption';
import { getActiveCompany } from '@/lib/company';
import type { OAuthTokens } from '@tourbillon/db/schema';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');
    
    if (error) {
      return NextResponse.redirect(
        `/settings?oauth_error=${encodeURIComponent(error)}`
      );
    }
    
    if (!code || !state) {
      return NextResponse.redirect('/settings?oauth_error=missing_parameters');
    }
    
    const stateData = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
    const { serverId, scope, userId, agentId } = stateData;
    
    const company = await getActiveCompany();
    
    if (serverId === 'github-mcp') {
      const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
      const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
      
      if (!clientId || !clientSecret) {
        return NextResponse.redirect('/settings?oauth_error=not_configured');
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
        return NextResponse.redirect('/settings?oauth_error=token_exchange_failed');
      }
      
      const tokenData = await tokenResponse.json();
      
      if (tokenData.error) {
        return NextResponse.redirect(
          `/settings?oauth_error=${encodeURIComponent(tokenData.error)}`
        );
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
      
      return NextResponse.redirect(`/settings?connected=${serverId}`);
    }
    
    return NextResponse.redirect('/settings?oauth_error=unsupported_provider');
  } catch (error) {
    console.error('Error in OAuth callback:', error);
    return NextResponse.redirect('/settings?oauth_error=callback_failed');
  }
}
