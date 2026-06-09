import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { createId } from '../utils';

export const activityLog = pgTable('activity_log', {
  id: text('id').primaryKey().$defaultFn(createId),
  companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  actorType: text('actor_type', { enum: ['agent', 'user', 'system'] }).notNull(),
  actorId: text('actor_id').notNull(),
  actorName: text('actor_name'),
  action: text('action').notNull(),  // e.g. 'issue.checked_out', 'issue.status_changed'
  entityType: text('entity_type').notNull(),  // e.g. 'issue', 'agent', 'approval'
  entityId: text('entity_id').notNull(),
  details: jsonb('details').default({}),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type ActivityLogEntry = typeof activityLog.$inferSelect;
export type NewActivityLogEntry = typeof activityLog.$inferInsert;
