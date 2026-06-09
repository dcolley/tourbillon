import { pgTable, text, timestamp, jsonb, boolean } from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { agents } from './agents';
import { createId } from '../utils';

export const routines = pgTable('routines', {
  id: text('id').primaryKey().$defaultFn(createId),
  companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  cronExpression: text('cron_expression').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  concurrencyPolicy: text('concurrency_policy', { enum: ['allow', 'forbid', 'replace'] }).notNull().default('forbid'),
  catchUpPolicy: text('catch_up_policy', { enum: ['skip', 'run'] }).notNull().default('skip'),
  taskTemplate: jsonb('task_template').notNull(),  // { title, description, priority, goalId }
  lastFiredAt: timestamp('last_fired_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type Routine = typeof routines.$inferSelect;
export type NewRoutine = typeof routines.$inferInsert;
