import { db } from './client';
import { vaultSecrets } from './schema/vault-secrets';
import { eq, and } from 'drizzle-orm';
import { decryptCredential, encryptCredential } from '@tourbillon/shared/vault-encryption';
import { resolveMcpCredential } from '@tourbillon/shared/mcp-credentials';
import type { OAuthTokens } from '@tourbillon/shared/vault-types';
import type { AgentRuntimeConfig, CompanySettings } from '@tourbillon/shared/types';

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

  // S308-S3: precedence agent → company_user → company. The first row that exists and is not
  // flagged needsReauth decides the answer (even when that answer is null — no fall-through to
  // a broader scope); a missing or needsReauth row falls through to the next scope.
  if (ctx.agentId) {
    const agentCred = await db.query.vaultSecrets.findFirst({
      where: and(
        ...conditions,
        eq(vaultSecrets.scope, 'agent'),
        eq(vaultSecrets.agentId, ctx.agentId)
      ),
    });
    if (agentCred && !agentCred.needsReauth) {
      return resolveScopedCredential(agentCred, ctx.serverId, 'agent');
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
      return resolveScopedCredential(userCred, ctx.serverId, 'user');
    }
  }

  const companyCred = await db.query.vaultSecrets.findFirst({
    where: and(...conditions, eq(vaultSecrets.scope, 'company')),
  });
  if (companyCred && !companyCred.needsReauth) {
    return resolveScopedCredential(companyCred, ctx.serverId, 'company');
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

type VaultSecretRow = typeof vaultSecrets.$inferSelect;

/**
 * S308-S3: one scope's credential row → its value — the body the agent, company_user and
 * company branches of `resolveVaultSecret` used to repeat verbatim. Decrypts; for an expired
 * OAuth token refreshes and writes the rotated tokens back. Behaviour per branch (pinned by
 * vault-credentials-304-softs / -308-softs):
 *   - refresh OK + write-back OK → the refreshed tokens (needsReauth cleared);
 *   - refresh OK + write-back FAILS (S308-S1) → the refreshed tokens, needsReauth flagged
 *     best-effort;
 *   - refresh FAILS (S308-S2) → needsReauth flagged, null;
 *   - decrypt (or the refresh-failure flag) throws → null.
 * `label` only names the scope in logs ('agent' | 'user' | 'company').
 */
async function resolveScopedCredential(
  row: VaultSecretRow,
  serverId: string,
  label: 'agent' | 'user' | 'company'
): Promise<string | OAuthTokens | null> {
  try {
    const decrypted = decryptCredential(row.encryptedValue);
    if (row.authType === 'oauth') {
      const tokens = decrypted as OAuthTokens;
      if (tokens.expiresAt && tokens.expiresAt < Date.now()) {
        const refreshed = await refreshOAuthToken(serverId, tokens);
        if (refreshed) {
          try {
            await db
              .update(vaultSecrets)
              .set({
                encryptedValue: encryptCredential(refreshed),
                needsReauth: false,
                updatedAt: new Date(),
              })
              .where(eq(vaultSecrets.id, row.id));
            return refreshed;
          } catch (persistErr) {
            // S308-S1: the refresh succeeded - only the write-back failed.
            // Returning null (the old behaviour: this error fell into the
            // outer "Failed to decrypt" catch) dropped the rotated tokens
            // with no reauth signal - fatal when the provider rotates
            // refresh tokens, since the stored copy is then already dead.
            // Documented choice: hand the live tokens to this caller (the
            // current wake keeps working) and flag needsReauth best-effort
            // so the stale row is not silently retried. If the flag
            // update also fails, the next wake's refresh attempt fails
            // and the refresh-failure branch self-heals to needsReauth.
            console.error(`Failed to persist refreshed ${label} credential:`, persistErr);
            await flagNeedsReauthAfterLostWriteBack(row.id, label);
            return refreshed;
          }
        } else {
          await db
            .update(vaultSecrets)
            .set({ needsReauth: true, updatedAt: new Date() })
            .where(eq(vaultSecrets.id, row.id));
          return null;
        }
      }
    }
    return decrypted;
  } catch (err) {
    console.error(`Failed to decrypt ${label} credential:`, err);
    return null;
  }
}

/**
 * S308-S1: best-effort needsReauth flag for when a SUCCESSFUL OAuth refresh
 * could not be persisted. Never throws - the caller has already decided its
 * response, and a failed flag only costs visibility: the next wake's refresh
 * attempt against the now-stale stored token fails and the refresh-failure
 * branch self-heals to needsReauth.
 */
async function flagNeedsReauthAfterLostWriteBack(
  credentialId: string,
  label: string
): Promise<void> {
  try {
    await db
      .update(vaultSecrets)
      .set({ needsReauth: true, updatedAt: new Date() })
      .where(eq(vaultSecrets.id, credentialId));
  } catch (flagErr) {
    console.error(
      `Failed to flag ${label} credential for reauth after lost write-back:`,
      flagErr
    );
  }
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
