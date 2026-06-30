import { pgTable, text, timestamp, boolean, jsonb } from 'drizzle-orm/pg-core';
import { createId } from '../utils';

export const llmProviderTypes = [
  'lmstudio',
  'ollama',
  'vllm',
  'openai',
  'openai-compatible',
] as const;

export type LlmProviderType = (typeof llmProviderTypes)[number];

export const llmProviders = pgTable('llm_providers', {
  id: text('id').primaryKey().$defaultFn(createId),
  name: text('name').notNull(),
  type: text('type', { enum: llmProviderTypes }).notNull(),
  baseURL: text('base_url').notNull(),
  apiKey: text('api_key'),
  headers: jsonb('headers').notNull().default({}),
  apiMode: text('api_mode', { enum: ['chat', 'responses'] }).notNull().default('chat'),
  defaultModelSettings: jsonb('default_model_settings').notNull().default({}),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type LlmProvider = typeof llmProviders.$inferSelect;
export type NewLlmProvider = typeof llmProviders.$inferInsert;
