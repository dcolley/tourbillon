import { pgTable, text, timestamp, boolean, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import { createId } from '../utils';
import { companies } from './companies';

export const llmProviderTypes = [
  'lmstudio',
  'ollama',
  'vllm',
  'openai',
  'openai-compatible',
] as const;

export type LlmProviderType = (typeof llmProviderTypes)[number];

export const stickinessTypes = ['off', 'agent', 'chat'] as const;
export type StickinessType = (typeof stickinessTypes)[number];

export const llmProviders = pgTable('llm_providers', {
  id: text('id').primaryKey().$defaultFn(createId),
  name: text('name').notNull(),
  type: text('type', { enum: llmProviderTypes }).notNull(),
  baseURL: text('base_url').notNull(),
  apiKey: text('api_key'),
  headers: jsonb('headers').notNull().default({}),
  apiMode: text('api_mode', { enum: ['chat', 'responses'] }).notNull().default('chat'),
  defaultModelSettings: jsonb('default_model_settings').notNull().default({}),
  /** Default model *id* for this provider (distinct from defaultModelSettings). */
  defaultModel: text('default_model'),
  isDefault: boolean('is_default').notNull().default(false),
  stickiness: text('stickiness', { enum: stickinessTypes }).notNull().default('off'),
  stickinessHeaderName: text('stickiness_header_name').notNull().default('x-litellm-session-id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type LlmProvider = typeof llmProviders.$inferSelect;
export type NewLlmProvider = typeof llmProviders.$inferInsert;

/**
 * PRV-1: per-company on/off switch for a provider. No row means enabled, so existing companies
 * keep every provider until someone switches one off.
 */
export const companyLlmProviders = pgTable(
  'company_llm_providers',
  {
    id: text('id').primaryKey().$defaultFn(createId),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    providerId: text('provider_id')
      .notNull()
      .references(() => llmProviders.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(true),
    updatedBy: text('updated_by'),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('company_llm_providers_company_provider_uidx').on(table.companyId, table.providerId),
  ],
);

export type CompanyLlmProvider = typeof companyLlmProviders.$inferSelect;
export type NewCompanyLlmProvider = typeof companyLlmProviders.$inferInsert;
