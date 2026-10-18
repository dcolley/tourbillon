import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { agents } from './agents';
import { createId } from '../utils';

export const approvals = pgTable('approvals', {
  id: text('id').primaryKey().$defaultFn(createId),
  companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),  // 'request_board_approval' | 'hire_agent' | etc.
  status: text('status', { enum: ['pending', 'approved', 'rejected'] }).notNull().default('pending'),
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
});

export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;

/**
 * Resume credentials for approvals forwarded to HITLy. Kept out of `approvals` so no approval
 * read can return them. Only a SHA-256 digest (bound to the approval id) is stored; a row is
 * single-use (`used_at`) and expires (`expires_at`).
 */
export const approvalResumeTokens = pgTable('approval_resume_tokens', {
  approvalId: text('approval_id').primaryKey().references(() => approvals.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  usedAt: timestamp('used_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type ApprovalResumeToken = typeof approvalResumeTokens.$inferSelect;
