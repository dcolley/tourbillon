import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { agents } from './agents';
import { createId } from '../utils';

export type HeartbeatStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'coalesced';
export type WakeReason =
  | 'timer'
  | 'assignment'
  | 'on_demand'
  | 'issue_commented'
  | 'issue_comment_mentioned'
  | 'issue_blockers_resolved'
  | 'issue_children_completed'
  | 'approval_resolved'
  | 'automation';

export const heartbeatRuns = pgTable('heartbeat_runs', {
  id: text('id').primaryKey().$defaultFn(createId),
  companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  invocationSource: text('invocation_source').$type<WakeReason>().notNull(),
  status: text('status').$type<HeartbeatStatus>().notNull().default('queued'),
  contextSnapshot: jsonb('context_snapshot').default({}),
  errorText: text('error_text'),
  shortLivedJwt: text('short_lived_jwt'),  // run-scoped API key
  startedAt: timestamp('started_at').notNull().defaultNow(),
  finishedAt: timestamp('finished_at'),
});

export type HeartbeatRun = typeof heartbeatRuns.$inferSelect;
export type NewHeartbeatRun = typeof heartbeatRuns.$inferInsert;
