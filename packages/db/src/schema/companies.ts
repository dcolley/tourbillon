import { pgTable, text, timestamp, integer, boolean, jsonb } from 'drizzle-orm/pg-core';
import { createId } from '../utils';

export const companies = pgTable('companies', {
  id: text('id').primaryKey().$defaultFn(createId),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  issuePrefix: text('issue_prefix').notNull(),  // e.g. 'ACME'
  issueCounter: integer('issue_counter').notNull().default(0),
  status: text('status', { enum: ['active', 'paused', 'archived'] }).notNull().default('active'),
  // Token budgets (local LM Studio = free, track tokens not dollars)
  budgetMonthlyTokens: integer('budget_monthly_tokens').notNull().default(10_000_000),
  spentMonthlyTokens: integer('spent_monthly_tokens').notNull().default(0),
  // Governance
  requiresBoardApprovalForHires: boolean('requires_board_approval_for_hires').notNull().default(true),
  // Company-level allowed MCP server IDs (policy; agents can only use servers on this list)
  allowedMcpServerIds: text('allowed_mcp_server_ids').array().notNull().default([]),
  // Metadata
  settings: jsonb('settings').default({}),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
