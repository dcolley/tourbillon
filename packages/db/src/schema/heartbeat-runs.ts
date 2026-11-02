import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import type { HeartbeatStatus } from '@tourbillon/shared/heartbeat-status';
import { companies } from './companies';
import { agents } from './agents';
import { createId } from '../utils';

// #299 S299-S2: the literal union moved to @tourbillon/shared/heartbeat-status (the
// shared→db type-only import was the edge that made the db↔shared workspace pair cyclic).
// Re-exported here so `import type { HeartbeatStatus } from '@tourbillon/db/schema'`
// keeps resolving, byte-for-byte the same members (column remains plain `text`).
export type { HeartbeatStatus };
export type WakeReason =
  | 'timer'
  | 'assignment'
  | 'on_demand'
  | 'issue_commented'
  | 'issue_comment_mentioned'
  | 'issue_blockers_resolved'
  | 'issue_children_completed'
  | 'approval_resolved'
  | 'automation'
  /** TASK-RUNNER: a Run Task wake claimed from the agent's private chat_tasks list. */
  | 'task';

export const heartbeatRuns = pgTable('heartbeat_runs', {
  id: text('id').primaryKey().$defaultFn(createId),
  companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  invocationSource: text('invocation_source').$type<WakeReason>().notNull(),
  status: text('status').$type<HeartbeatStatus>().notNull().default('queued'),
  contextSnapshot: jsonb('context_snapshot').default({}),
  errorText: text('error_text'),
  traceId: text('trace_id'),
  harnessRunId: text('harness_run_id'),
  durableRunId: text('durable_run_id'),
  shortLivedJwt: text('short_lived_jwt'),  // run-scoped API key
  startedAt: timestamp('started_at').notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at'),
  finishedAt: timestamp('finished_at'),
});

export type HeartbeatRun = typeof heartbeatRuns.$inferSelect;
export type NewHeartbeatRun = typeof heartbeatRuns.$inferInsert;
