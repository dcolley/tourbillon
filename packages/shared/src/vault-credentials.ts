import { db } from '@tourbillon/db';
import { vaultSecrets } from '@tourbillon/db/schema';
import { eq, and } from 'drizzle-orm';
import { decryptCredential } from './vault-encryption';
import { resolveMcpCredential } from './mcp-credentials';
import type { OAuthTokens } from '@tourbillon/db/schema';
import type { AgentRuntimeConfig, CompanySettings } from './types';

export interface VaultCredentialContext {
  companyId: string;
  serverId: string;
  agentId?: string;
  userId?: string;
  agentRuntime?: AgentRuntimeConfig | null;
  companySettings?: CompanySettings | null;
}

export async function resolveVaultSecret(
  ctx: VaultCredentialContext
): Promise<string | OAuthTokens | null> {
  const conditions = [
    eq(vaultSecrets.companyId, ctx.companyId),
    eq(vaultSecrets.serverId, ctx.serverId),
  ];

  if (ctx.agentId) {
    const agentCred = await db.query.vaultSecrets.findFirst({
      where: and(
        ...conditions,
        eq(vaultSecrets.scope, 'agent'),
        eq(vaultSecrets.agentId, ctx.agentId)
      ),
    });

    if (agentCred && !agentCred.needsReauth) {
      try {
        const decrypted = decryptCredential(agentCred.encryptedValue);
        if (agentCred.authType === 'oauth') {
          const tokens = decrypted as OAuthTokens;
          if (tokens.expiresAt && tokens.expiresAt < Date.now()) {
            const refreshed = await refreshOAuthToken(ctx.serverId, tokens);
            if (refreshed) {
              await db
                .update(vaultSecrets)
                .set({
                  encryptedValue: require('./vault-encryption').encryptCredential(refreshed),
                  needsReauth: false,
                  updatedAt: new Date(),
                })
                .where(eq(vaultSecrets.id, agentCred.id));
              return refreshed;
            } else {
              await db
                .update(vaultSecrets)
                .set({ needsReauth: true, updatedAt: new Date() })
                .where(eq(vaultSecrets.id, agentCred.id));
              return null;
            }
          }
        }
        return decrypted;
      } catch (err) {
        console.error('Failed to decrypt agent credential:', err);
        return null;
      }
    }
  }

  if (ctx.userId) {
    const userCred = await db.query.vaultSecrets.findFirst({
      where: and(
        ...conditions,
        eq(vaultSecrets.scope, 'company_user'),
        eq(vaultSecrets.userId, ctx.userId)
      ),
    });

    if (userCred && !userCred.needsReauth) {
      try {
        const decrypted = decryptCredential(userCred.encryptedValue);
        if (userCred.authType === 'oauth') {
          const tokens = decrypted as OAuthTokens;
          if (tokens.expiresAt && tokens.expiresAt < Date.now()) {
            const refreshed = await refreshOAuthToken(ctx.serverId, tokens);
            if (refreshed) {
              await db
                .update(vaultSecrets)
                .set({
                  encryptedValue: require('./vault-encryption').encryptCredential(refreshed),
                  needsReauth: false,
                  updatedAt: new Date(),
                })
                .where(eq(vaultSecrets.id, userCred.id));
              return refreshed;
            } else {
              await db
                .update(vaultSecrets)
                .set({ needsReauth: true, updatedAt: new Date() })
                .where(eq(vaultSecrets.id, userCred.id));
              return null;
            }
          }
        }
        return decrypted;
      } catch (err) {
        console.error('Failed to decrypt user credential:', err);
        return null;
      }
    }
  }

  const companyCred = await db.query.vaultSecrets.findFirst({
    where: and(...conditions, eq(vaultSecrets.scope, 'company')),
  });

  if (companyCred && !companyCred.needsReauth) {
    try {
      const decrypted = decryptCredential(companyCred.encryptedValue);
      if (companyCred.authType === 'oauth') {
        const tokens = decrypted as OAuthTokens;
        if (tokens.expiresAt && tokens.expiresAt < Date.now()) {
          const refreshed = await refreshOAuthToken(ctx.serverId, tokens);
          if (refreshed) {
            await db
              .update(vaultSecrets)
              .set({
                encryptedValue: require('./vault-encryption').encryptCredential(refreshed),
                needsReauth: false,
                updatedAt: new Date(),
              })
              .where(eq(vaultSecrets.id, companyCred.id));
            return refreshed;
          } else {
            await db
              .update(vaultSecrets)
              .set({ needsReauth: true, updatedAt: new Date() })
              .where(eq(vaultSecrets.id, companyCred.id));
            return null;
          }
        }
      }
      return decrypted;
    } catch (err) {
      console.error('Failed to decrypt company credential:', err);
      return null;
    }
  }

  // US-V5 Option A: Transition window dual-read fallback
  // TODO: Remove after migration complete + verified (when settings.mcpCredentials cleared)
  // This fallback is temporary to ensure zero downtime during vault rollout
  const legacyCredential = resolveMcpCredential({
    serverId: ctx.serverId,
    agentRuntime: ctx.agentRuntime,
    companySettings: ctx.companySettings,
  });
  
  return legacyCredential;
}

async function refreshOAuthToken(
  serverId: string,
  tokens: OAuthTokens
): Promise<OAuthTokens | null> {
  if (!tokens.refreshToken) {
    return null;
  }

  try {
    if (serverId === 'github-mcp') {
      const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
      const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        console.error('GitHub OAuth credentials not configured');
        return null;
      }

      const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
          refresh_token: tokens.refreshToken,
        }),
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();

      if (data.error) {
        return null;
      }

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || tokens.refreshToken,
        expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
        scope: data.scope || tokens.scope,
      };
    }

    return null;
  } catch (err) {
    console.error('Failed to refresh OAuth token:', err);
    return null;
  }
}

export async function resolvePluginCredential(
  ctx: VaultCredentialContext
): Promise<string | OAuthTokens | null> {
  return resolveVaultSecret(ctx);
}

export async function getVaultCredentialStatus(
  companyId: string,
  serverId: string,
  scope: 'company' | 'company_user' | 'agent',
  userId?: string,
  agentId?: string
): Promise<{ configured: boolean; needsReauth: boolean }> {
  const conditions = [
    eq(vaultSecrets.companyId, companyId),
    eq(vaultSecrets.serverId, serverId),
    eq(vaultSecrets.scope, scope),
  ];

  if (scope === 'company_user' && userId) {
    conditions.push(eq(vaultSecrets.userId, userId));
  }

  if (scope === 'agent' && agentId) {
    conditions.push(eq(vaultSecrets.agentId, agentId));
  }

  const credential = await db.query.vaultSecrets.findFirst({
    where: and(...conditions),
  });

  return {
    configured: !!credential,
    needsReauth: credential?.needsReauth ?? false,
  };
}
