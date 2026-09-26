import { db } from '@tourbillon/db';
import { vaultSecrets } from '@tourbillon/db/schema';
import { eq, and } from 'drizzle-orm';

export interface VaultCredentialStatus {
  configured: boolean;
  needsReauth: boolean;
  authType?: 'api_key' | 'oauth';
}

export async function getVaultCredentialStatus(
  companyId: string,
  serverId: string,
  scope: 'company' | 'company_user' | 'agent',
  userId?: string,
  agentId?: string
): Promise<VaultCredentialStatus> {
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
    authType: credential?.authType as 'api_key' | 'oauth' | undefined,
  };
}
