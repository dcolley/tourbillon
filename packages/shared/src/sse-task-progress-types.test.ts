/**
 * S4 (#196 soft-pack): the SSE channel contract for Run Task progress chips.
 *
 * The scheduler publishes `{ type: 'chat_task_progress', ...ChatTaskProgressEvent }` and the
 * web bridge parses exactly that — but for most of #196 the shared enum still said the old,
 * never-emitted `task_run_update`. This file is the type-level guard: it must FAIL TO COMPILE
 * if `chat_task_progress` stops being a member of SSEEventType, or if the drifted
 * `task_run_update` name comes back. The runtime asserts keep the pinned constant honest.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TASK_PROGRESS_SSE_TYPE, type SSEEvent, type SSEEventType } from './types';

// Type level (compile gate): the pinned constant must be a member of the enum...
type IsMember = typeof TASK_PROGRESS_SSE_TYPE extends SSEEventType ? true : never;
const member: IsMember = true;
// ...and the old drifted name must NOT be a member again.
type IsGone = Extract<SSEEventType, 'task_run_update'> extends never ? true : never;
const gone: IsGone = true;
void member;
void gone;

test('S4: chat_task_progress is the one SSE type for Run Task progress (SSEEventType contract)', () => {
  assert.equal(TASK_PROGRESS_SSE_TYPE, 'chat_task_progress');
  // The enum member is usable on the shared envelope (assignment IS the check).
  const event: SSEEvent = {
    type: TASK_PROGRESS_SSE_TYPE,
    companyId: 'company-1',
    agentId: 'agent-1',
    runId: 'run-1',
    timestamp: new Date().toISOString(),
  };
  assert.equal(event.type, 'chat_task_progress');
  // Every SSEEventType literal the UI routes on is still present (no accidental removals).
  const kinds: SSEEventType[] = [
    'heartbeat.started',
    'heartbeat.completed',
    'heartbeat.failed',
    'chat_task_progress',
    'agent.budget_exceeded',
    'issue.status_changed',
    'issue.assigned',
    'approval.created',
    'approval.decided',
  ];
  assert.equal(kinds.length, 9);
});
