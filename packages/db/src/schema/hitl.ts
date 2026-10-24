import { pgTable, text, timestamp, jsonb, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { approvals } from './approvals';
import { createId } from '../utils';

/**
 * APR-2: `hitl/event/v0` reviewer activity for one approval, hash-chained per approval
 * (`prev_hash` = previous event's `hash`, `seq` orders the chain).
 */
export const hitlEvents = pgTable('hitl_events', {
  id: text('id').primaryKey().$defaultFn(createId),
  companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  approvalId: text('approval_id').notNull().references(() => approvals.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  type: text('type', { enum: ['presented', 'opened', 'decided', 'bytes', 'scroll'] }).notNull(),
  itemRef: text('item_ref'),
  at: timestamp('at', { withTimezone: true }).notNull(),
  actorKind: text('actor_kind', { enum: ['human', 'group', 'service'] }).notNull(),
  actorId: text('actor_id').notNull(),
  source: text('source', { enum: ['host', 'client'] }).notNull(),
  data: jsonb('data'),
  prevHash: text('prev_hash'),
  hash: text('hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('hitl_events_approval_seq_uidx').on(table.approvalId, table.seq),
]);

/**
 * APR-2: opaque per-reviewer link tokens for `/o/<token>`. Bound to one approval, one item
 * (`item_ref`, or '' for the approval's own details page) and one reviewer. The token carries no
 * target: the redirect goes only to the URL stored in the request. Redeeming needs a board session
 * in the token's company.
 */
export const hitlLinkTokens = pgTable('hitl_link_tokens', {
  token: text('token').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  approvalId: text('approval_id').notNull().references(() => approvals.id, { onDelete: 'cascade' }),
  itemRef: text('item_ref').notNull().default(''),
  reviewerKind: text('reviewer_kind', { enum: ['human', 'group', 'service'] }).notNull(),
  reviewerId: text('reviewer_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('hitl_link_tokens_binding_uidx').on(table.approvalId, table.itemRef, table.reviewerId),
  index('hitl_link_tokens_company_idx').on(table.companyId),
]);

export type HitlEventRow = typeof hitlEvents.$inferSelect;
export type NewHitlEventRow = typeof hitlEvents.$inferInsert;
export type HitlLinkToken = typeof hitlLinkTokens.$inferSelect;
