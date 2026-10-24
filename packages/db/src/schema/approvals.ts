import { pgTable, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { companies } from './companies';
import { agents } from './agents';
import { createId } from '../utils';

/**
 * Stored approval status. `approved` / `rejected` are binary answers (`hitl/response/v0` status
 * answered with value approve / reject); `answered` is a non-binary answer; `declined`,
 * `cancelled` and `expired` are the other response statuses (APR-2). Plain text column: adding a
 * status needs no DDL.
 */
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'answered', 'declined', 'cancelled', 'expired'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const approvals = pgTable('approvals', {
  id: text('id').primaryKey().$defaultFn(createId),
  companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),  // 'request_board_approval' | 'hire_agent' | etc.
  status: text('status', { enum: APPROVAL_STATUSES }).notNull().default('pending'),
  requestedByAgentId: text('requested_by_agent_id').references(() => agents.id, { onDelete: 'set null' }),
  decidedByUserId: text('decided_by_user_id'),
  issueIds: text('issue_ids').array().notNull().default([]),  // linked source issues
  payload: jsonb('payload').notNull().default({}),
  note: text('note'),  // board's decision note
  decidedAt: timestamp('decided_at'),
  hitlyApprovalId: text('hitly_approval_id'),  // HITLy work item id
  hitlyError: text('hitly_error'),  // HITLy ingest/resume error message
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  /**
   * APR-2: the `hitl/request/v0` ask (host `id` = approvals.id), or null for a legacy approval.
   * Kept out of `payload`, which is returned raw and holds resume tokens.
   */
  hitlRequest: jsonb('hitl_request'),
  /** APR-2: the `hitl/response/v0` outcome, written by the same conditional update that decides. */
  hitlResponse: jsonb('hitl_response'),
  /** APR-2: requester's handle; a repeat from the same agent returns the existing approval. */
  idempotencyKey: text('idempotency_key'),
  /** APR-2: request deadline; the expiry sweep closes pending rows past it as `expired`. */
  deadline: timestamp('deadline', { withTimezone: true }),
  /** APR-2: when the ask was first shown to a reviewer (`activity.presentedAt`). */
  presentedAt: timestamp('presented_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('approvals_idempotency_uidx')
    .on(table.companyId, table.requestedByAgentId, table.idempotencyKey)
    .where(sql`${table.idempotencyKey} is not null`),
  index('approvals_pending_deadline_idx')
    .on(table.deadline)
    .where(sql`${table.status} = 'pending' and ${table.deadline} is not null`),
]);

export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;
