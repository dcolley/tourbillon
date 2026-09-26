import { pgTable, text, timestamp, boolean, jsonb, unique, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { companies } from './companies';
import { agents } from './agents';
import { user } from './users';
import { createId } from '../utils';

export const vaultSecrets = pgTable(
  'vault_secrets',
  {
    id: text('id').primaryKey().$defaultFn(createId),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    serverId: text('server_id').notNull(),
    scope: text('scope', { enum: ['company', 'company_user', 'agent'] }).notNull(),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    authType: text('auth_type', { enum: ['api_key', 'oauth'] }).notNull(),
    encryptedValue: text('encrypted_value').notNull(),
    needsReauth: boolean('needs_reauth').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index('vault_secrets_company_idx').on(table.companyId),
    uniqueCredential: unique('vault_secrets_unique_credential').on(
      table.companyId,
      table.serverId,
      table.scope,
      table.userId,
      table.agentId
    ),
  })
);

export const vaultSecretsRelations = relations(vaultSecrets, ({ one }) => ({
  company: one(companies, { fields: [vaultSecrets.companyId], references: [companies.id] }),
  userRef: one(user, { fields: [vaultSecrets.userId], references: [user.id] }),
  agent: one(agents, { fields: [vaultSecrets.agentId], references: [agents.id] }),
}));

export type VaultSecret = typeof vaultSecrets.$inferSelect;
export type NewVaultSecret = typeof vaultSecrets.$inferInsert;

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}
