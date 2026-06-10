import { pgTable, text, timestamp, integer, boolean, jsonb } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { companies } from './companies';
import { createId } from '../utils';

export const agents = pgTable('agents', {
  id: text('id').primaryKey().$defaultFn(createId),
  companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  // Identity
  name: text('name').notNull(),
  role: text('role').notNull(),  // 'ceo' | 'cto' | 'engineer' | 'pm' | 'qa' | 'designer' | 'custom'
  title: text('title').notNull(),
  icon: text('icon').default('bot'),
  urlKey: text('url_key').notNull(),  // e.g. 'cto' — used in links
  // Org chart
  reportsToId: text('reports_to_id'),  // self-referential FK — set after all agents created
  // Adapter configuration
  adapterType: text('adapter_type', { enum: ['lmstudio', 'ollama', 'process', 'http'] }).notNull().default('lmstudio'),
  adapterConfig: jsonb('adapter_config').notNull().default({}),
  // Model
  modelId: text('model_id').default('meta-llama/Llama-3.3-70B-Instruct'),
  // Instructions
  instructionsBundleSoulMd: text('instructions_bundle_soul_md'),  // SOUL.md content
  instructionsBundleAgentsMd: text('instructions_bundle_agents_md'),  // AGENTS.md content
  instructionsPath: text('instructions_path'),  // optional file path override
  // Skills (slugs of SKILL.md files to inject at wake time)
  assignedSkills: text('assigned_skills').array().notNull().default(['control-plane']),
  // Tools (Tier 2: role-gated toolsets)
  assignedToolsets: text('assigned_toolsets').array().notNull().default([]),
  // MCP servers (Tier 3: capability-gated)
  mcpServerIds: text('mcp_server_ids').array().notNull().default([]),
  // Budget
  budgetMonthlyTokens: integer('budget_monthly_tokens').notNull().default(500_000),
  spentMonthlyTokens: integer('spent_monthly_tokens').notNull().default(0),
  // Status
  status: text('status', { enum: ['active', 'paused', 'archived', 'pending_approval'] }).notNull().default('active'),
  // Runtime config
  runtimeConfig: jsonb('runtime_config').notNull().default({
    heartbeat: { enabled: false, intervalSec: 0, wakeOnAssignment: true, wakeOnDemand: true },
    timeout: { heartbeatSec: 300, graceSec: 30 },
  }),
  defaultBillingCode: text('default_billing_code').default('default'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const agentsRelations = relations(agents, ({ one, many }) => ({
  company: one(companies, { fields: [agents.companyId], references: [companies.id] }),
  reportsTo: one(agents, { fields: [agents.reportsToId], references: [agents.id], relationName: 'reports_to' }),
  reports: many(agents, { relationName: 'reports_to' }),
}));

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
