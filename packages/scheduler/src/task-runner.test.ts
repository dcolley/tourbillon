/**
 * TASK-RUNNER unit tests — the shared per-agent run budget and the Run Task queue rules,
 * driven against fake TaskRunnerDeps (no database, no model). The poller gates tasks
 * through the SAME slot pool heartbeats use (one per-agent budget, not a second unlimited
 * runner); paused and attempt-exhausted tasks never enqueue; a task that waits for a slot
 * keeps its attempt budget; a task wake is a different KIND of job (no issue taskId).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTaskRunWake,
  freeTaskRunSlots,
  pollTaskRunner,
  taskRunSettleStatus,
  type TaskRunPollSummary,
  type TaskRunSlotState,
  type TaskRunnerDeps,
} from './task-runner';
import { buildWakeMessageWithStats } from '@tourbillon/shared';
import type { RunnableChatTaskRow } from '@tourbillon/db';
import type { HeartbeatJobData } from '@tourbillon/shared';
import type { WakeResult } from './wake-runner';

const A = 'agent-1';
const C = 'company-1';

function row(over: Partial<RunnableChatTaskRow> = {}): RunnableChatTaskRow {
  return {
    companyId: C,
    agentId: A,
    title: 'Ship the runbook',
    notes: null,
    position: 0,
    attempts: 0,
    paused: false,
    sourceThreadId: null,
    agentName: 'Ada',
    agentUrlKey: 'ada',
    agentStatus: 'active',
    companyStatus: 'active',
    ...over,
  } as unknown as RunnableChatTaskRow;
}

interface Fakes {
  deps: TaskRunnerDeps;
  claims: Array<{ taskId: string; runId: string }>;
  jobs: HeartbeatJobData[];
  settles: Array<{ taskId: string; status: string }>;
  progress: string[];
}

function fakes(opts: {
  rows: RunnableChatTaskRow[];
  slots?: TaskRunSlotState;
  wake?: (job: HeartbeatJobData) => Promise<WakeResult>;
}): Fakes {
  const f: Fakes = {
    deps: null as unknown as TaskRunnerDeps,
    claims: [],
    jobs: [],
    settles: [],
    progress: [],
  };
  f.deps = {
    db: null as unknown as TaskRunnerDeps['db'],
    listRunnable: async () => opts.rows,
    countActiveRuns: async () => opts.slots ?? { total: 0, task: 0 },
    claim: async (taskId, runId) => {
      f.claims.push({ taskId, runId });
      return true;
    },
    startWake: async (job) => {
      f.jobs.push(job);
      if (opts.wake) return opts.wake(job);
      return { runId: job.runId ?? '', status: 'succeeded' };
    },
    settle: async (taskId, status) => {
      f.settles.push({ taskId, status });
    },
    emitProgress: (event) => {
      f.progress.push(`${event.stage}:${event.status}`);
    },
  };
  return f;
}

const drain = (s: TaskRunPollSummary) => Promise.all(s.started.map((x) => x.done));

test('freeTaskRunSlots: the shared budget and the task cap both clamp, never negative', () => {
  // Two heartbeat slots busy → no room for tasks (tasks wait, they never stack a parallel runner).
  assert.equal(freeTaskRunSlots({ total: 2, task: 0 }, 2, 2), 0);
  // Task cap spent while the budget still has room → wait too (task runs stay capped).
  assert.equal(freeTaskRunSlots({ total: 2, task: 2 }, 4, 2), 0);
  assert.equal(freeTaskRunSlots({ total: 0, task: 2 }, 2, 2), 0);
  // Two slots of two used → nothing free, whichever kind they were.
  assert.equal(freeTaskRunSlots({ total: 2, task: 1 }, 2, 2), 0);
  // One heartbeat slot of three → tasks may use the two remaining slots (inside budget AND cap).
  assert.equal(freeTaskRunSlots({ total: 1, task: 0 }, 3, 2), 2);
  assert.equal(freeTaskRunSlots({ total: 3, task: 0 }, 2, 2), 0);
});

test('wait-when-full: slots busy → the task waits and keeps its attempt budget', async () => {
  const f = fakes({ rows: [row({ taskId: 't1' }), row({ taskId: 't2', position: 1 })], slots: { total: 2, task: 0 } });
  const s = await pollTaskRunner(f.deps, {});
  assert.equal(s.started.length, 0);
  assert.equal(s.skippedFull, 1);
  assert.deepEqual(f.claims, []); // no claim → attempt budget untouched while waiting
  assert.deepEqual(f.jobs, []);
  assert.deepEqual(f.settles, []);
});

test('task cap inside the budget: two busy slots of three → one task may start', async () => {
  const rows = [row({ taskId: 't1', position: 0 }), row({ taskId: 't2', position: 1 })];
  const f = fakes({ rows, slots: { total: 2, task: 1 } });
  const s = await pollTaskRunner(f.deps, { maxConcurrentRuns: 3, taskCap: 2 });
  // Budget: 3 − 2 busy = 1 free; cap: 2 − 1 task run = 1 free → exactly one task may start.
  assert.equal(s.started.length, 1);
  assert.equal(f.jobs.length, 1);
  const job = f.jobs[0]!;
  assert.equal(job.kind, 'task');
  assert.equal(job.wakeReason, 'task');
  assert.equal(job.invocationSource, 'task');
  assert.equal(job.taskId, undefined); // NOT an issue assignment — no checkout lock, no board row
  assert.equal(job.chatTaskId, 't1');
  assert.ok(job.runId);
  await drain(s);
  assert.deepEqual(f.settles, [{ taskId: 't1', status: 'done' }]);
  assert.deepEqual(f.progress, ['started:running', 'done:succeeded']);
});

test('paused tasks skip the queue even when slots are free', async () => {
  const f = fakes({ rows: [row({ taskId: 't1', paused: true })], slots: { total: 0, task: 0 } });
  const s = await pollTaskRunner(f.deps, {});
  assert.equal(s.polled, 1);
  assert.equal(s.started.length, 0);
  assert.deepEqual(f.jobs, []);
});

test('B1: paused/archived agents and companies are skipped BEFORE claim — never claimed, never parked', async () => {
  // Free slots, so the ONLY thing that may stop these rows is the status gate. Claiming an
  // inactive agent's task burns runner_attempts and the skipped wake parks it to
  // waiting_on_user — the poller must not touch it at all (stays pending, attempts unchanged).
  const rows = [
    row({ taskId: 't-paused-agent', agentStatus: 'paused' }),
    row({ taskId: 't-archived-agent', agentStatus: 'archived' }),
    row({ taskId: 't-pending-agent', agentStatus: 'pending_approval' }),
    row({ taskId: 't-archived-company', companyStatus: 'archived' }),
    row({ taskId: 't-paused-company', companyStatus: 'paused' }),
    row({ taskId: 't-active', position: 9 }), // the control: active agent + active company runs
  ];
  const f = fakes({ rows, slots: { total: 0, task: 0 } });
  const s = await pollTaskRunner(f.deps, {});
  assert.equal(s.polled, 6);
  assert.equal(s.skippedInactive, 5);
  assert.equal(s.skippedFull, 0); // inactive rows are NOT counted as a budget deferral
  // Only the active row was claimed (claim is what mutates attempts — no claim, no burn).
  assert.deepEqual(f.claims.map((c) => c.taskId), ['t-active']);
  assert.deepEqual(f.jobs.map((j) => j.chatTaskId), ['t-active']);
  await drain(s);
  assert.deepEqual(f.settles, [{ taskId: 't-active', status: 'done' }]); // inactive rows never settle
});

test('a failed run re-queues to pending while attempts remain, then parks itself', async () => {
  const fail = (job: HeartbeatJobData) =>
    Promise.resolve({ runId: job.runId ?? '', status: 'failed' as const, errorText: 'boom' });
  const first = fakes({ rows: [row({ taskId: 't1', attempts: 0 })], wake: fail });
  const s1 = await pollTaskRunner(first.deps, {});
  await drain(s1);
  assert.deepEqual(first.settles, [{ taskId: 't1', status: 'pending' }]); // fresh attempt available
  assert.deepEqual(first.progress, ['started:running', 'needs_review:failed']);

  const last = fakes({ rows: [row({ taskId: 't2', attempts: 1 })], wake: fail });
  const s2 = await pollTaskRunner(last.deps, {});
  await drain(s2);
  assert.deepEqual(last.settles, [{ taskId: 't2', status: 'waiting_on_user' }]); // attempt budget spent → park
});

test('taskRunSettleStatus maps run outcome + attempt budget', () => {
  assert.equal(taskRunSettleStatus({ status: 'succeeded' }, 1), 'done');
  assert.equal(taskRunSettleStatus({ status: 'failed' }, 1), 'pending');
  assert.equal(taskRunSettleStatus({ status: 'failed' }, 2), 'waiting_on_user');
  assert.equal(taskRunSettleStatus({ status: 'skipped' }, 1), 'waiting_on_user');
});

test('a task wake carries the task message, not the heartbeat T1 header, and links its run id', () => {
  const wake = buildTaskRunWake(row({ taskId: 't9' }), 'run-9');
  assert.equal(wake.kind, 'task');
  assert.equal(wake.taskId, undefined);
  assert.equal(wake.runId, 'run-9');
  assert.equal(wake.chatTaskTitle, 'Ship the runbook');

  const taskMsg = buildWakeMessageWithStats(wake, {});
  assert.match(taskMsg.message, /Run Task/);
  assert.match(taskMsg.message, /Ship the runbook/);
  assert.ok(!taskMsg.message.includes('NEEDS-DECISION')); // the parked path is a tool call, not a reply token

  const heartbeat = buildWakeMessageWithStats(
    { agentId: A, agentName: 'Ada', companyId: C, invocationSource: 'timer', wakeReason: 'timer' },
    {},
  );
  assert.ok(!heartbeat.message.includes('Run Task'));
});
