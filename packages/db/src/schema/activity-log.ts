import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
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
  /**
   * ACT-1: shared by every row written for one action (e.g. an approval decision and the issue
   * restores, comments and wakes it caused), so the Activity view can group them. Null for rows
   * written on their own and for rows from before 0021.
   */
  correlationId: text('correlation_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('activity_log_company_created_idx').on(table.companyId, table.createdAt),
  index('activity_log_company_entity_idx').on(table.companyId, table.entityType, table.entityId),
  index('activity_log_company_correlation_idx')
    .on(table.companyId, table.correlationId)
    .where(sql`${table.correlationId} is not null`),
]);

export type ActivityLogEntry = typeof activityLog.$inferSelect;
export type NewActivityLogEntry = typeof activityLog.$inferInsert;
