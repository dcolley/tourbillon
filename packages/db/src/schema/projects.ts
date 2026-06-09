import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { goals } from './goals';
import { agents } from './agents';
import { createId } from '../utils';

export const projects = pgTable('projects', {
  id: text('id').primaryKey().$defaultFn(createId),
  companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  goalId: text('goal_id').references(() => goals.id, { onDelete: 'set null' }),
  ownerAgentId: text('owner_agent_id').references(() => agents.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status', { enum: ['active', 'paused', 'completed', 'archived'] }).notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
