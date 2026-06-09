import { pgTable, text, timestamp, integer } from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { agents } from './agents';
import { createId } from '../utils';

export const costEvents = pgTable('cost_events', {
  id: text('id').primaryKey().$defaultFn(createId),
  companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  runId: text('run_id'),  // heartbeat run that generated this cost
  issueId: text('issue_id'),  // issue being worked on (if applicable)
  provider: text('provider').notNull().default('lmstudio'),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  // costCents = 0 for local models; present for future cloud model support
  costCents: integer('cost_cents').notNull().default(0),
  billingCode: text('billing_code').default('default'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type CostEvent = typeof costEvents.$inferSelect;
export type NewCostEvent = typeof costEvents.$inferInsert;
