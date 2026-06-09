import { pgTable, text, timestamp, boolean, jsonb } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { companies } from './companies';
import { agents } from './agents';
import { goals } from './goals';
import { projects } from './projects';
import { createId } from '../utils';

export type IssueStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked' | 'cancelled';
export type IssuePriority = 'critical' | 'high' | 'medium' | 'low';

export const issues = pgTable('issues', {
  id: text('id').primaryKey().$defaultFn(createId),
  companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  // Human-stable identifier: "ACME-42"
  identifier: text('identifier').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').$type<IssueStatus>().notNull().default('backlog'),
  priority: text('priority').$type<IssuePriority>().notNull().default('medium'),
  // Hierarchy
  parentId: text('parent_id'),  // self-ref, set after creation
  goalId: text('goal_id').references(() => goals.id, { onDelete: 'set null' }),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
  routineId: text('routine_id'),  // set when created by a routine tick
  // Assignment
  assigneeAgentId: text('assignee_agent_id').references(() => agents.id, { onDelete: 'set null' }),
  assigneeUserId: text('assignee_user_id'),
  // Atomic checkout — the DB row IS the lock
  checkoutRunId: text('checkout_run_id'),
  executionLockedAt: timestamp('execution_locked_at'),
  executionAgentNameKey: text('execution_agent_name_key'),
  // Dependencies (array of blocked-by issue IDs)
  blockedByIssueIds: text('blocked_by_issue_ids').array().notNull().default([]),
  // Workspace (for execution context inheritance)
  inheritExecutionWorkspaceFromIssueId: text('inherit_execution_workspace_from_issue_id'),
  // Billing
  billingCode: text('billing_code').default('default'),
  // Source
  source: text('source', { enum: ['manual', 'agent', 'routine', 'import'] }).notNull().default('manual'),
  // Timestamps
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const issuesRelations = relations(issues, ({ one, many }) => ({
  company: one(companies, { fields: [issues.companyId], references: [companies.id] }),
  goal: one(goals, { fields: [issues.goalId], references: [goals.id] }),
  project: one(projects, { fields: [issues.projectId], references: [projects.id] }),
  assigneeAgent: one(agents, { fields: [issues.assigneeAgentId], references: [agents.id] }),
  parent: one(issues, { fields: [issues.parentId], references: [issues.id], relationName: 'parent_child' }),
  children: many(issues, { relationName: 'parent_child' }),
}));

export type Issue = typeof issues.$inferSelect;
export type NewIssue = typeof issues.$inferInsert;
