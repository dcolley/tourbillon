import type { WakeReason } from './types';

/**
 * #275 / #295 S295-S2: the single source of truth for wake reasons where `taskId` means
 * "this agent was assigned this issue".
 *
 * Two consumers, previously duplicated "kept in sync deliberately" with no parity pin:
 *  - packages/scheduler/src/wake-runner.ts — gates the assignee-mismatch pre-flight check
 *    on this set (only task-scoped wakes may be assignee-checked; an `approval_resolved`
 *    taskId names a LINKED issue, context only, so checking it failed every requester
 *    wake whose first linked issue belonged to another agent).
 *  - apps/web/lib/retry-failed-heartbeat.ts — decides which retry snapshots keep their
 *    taskId + wakePayloadJson (task-scoped) vs degrade to `on_demand`.
 *
 * scheduler cannot import from web, so the set lives here. Mutation coverage: dropping any
 * member must turn the scheduler assignee tests (wake-runner-295-softs.test.ts), the web
 * retry tests (retry-failed-heartbeat.test.ts) and the parity pins below
 * (task-scoped-wake-reasons.test.ts) RED.
 */
export const TASK_SCOPED_WAKE_REASONS: ReadonlySet<WakeReason> = new Set<WakeReason>([
  'assignment',
  'issue_commented',
  'issue_comment_mentioned',
  'issue_blockers_resolved',
  'issue_children_completed',
]);
