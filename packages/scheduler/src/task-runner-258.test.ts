/**
 * TASK-AUDIT (#258): the Run Task lifecycle audit rows (activity_log, entity_type 'chat_task').
 *
 * The poller must write one audit row per transition it owns — claim (chat_task.queued), wake
 * fire (chat_task.started), settle (chat_task.done / chat_task.error / chat_task.parked) — with
 * the run link, the stored status and the product lifecycle word. Skips (paused / inactive /
 * company-disabled) write NOTHING (no transition happened), and a throwing audit seam must
 * never break the queue: the run still starts, settles, and the tick summary is unchanged.
 *
 * Same fake-deps harness as task-runner.test.ts — no database, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pollTaskRunner,
  taskRunSettleActivityAction,
  type ChatTaskActivityEvent,
  type TaskRunPollSummary,
  type TaskRunnerDeps,
} from './task-runner';
import type { RunnableChatTaskRow } from '@tourbillon/db';
import type { HeartbeatJobData } from '@tourbillon/shared';
import type { WakeResult } from './wake-runner';

process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused';

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

function fakes(opts: {
  rows: RunnableChatTaskRow[];
  slots?: { total: number; task: number };
  wake?: (job: HeartbeatJobData) => Promise<WakeResult>;
}): { deps: TaskRunnerDeps; activity: ChatTaskActivityEvent[] } {
  const activity: ChatTaskActivityEvent[] = [];
  const deps: TaskRunnerDeps = {
    db: null as unknown as TaskRunnerDeps['db'],
    listRunnable: async () => opts.rows,
    countActiveRuns: async () => opts.slots ?? { total: 0, task: 0 },
    claim: async () => true,
    startWake: async (job) => (opts.wake ? opts.wake(job) : { runId: job.runId ?? '', status: 'succeeded' }),
    settle: async () => undefined,
    logActivity: (event) => {
      activity.push(event);
    },
  };
  return { deps, activity };
}

const drain = (s: TaskRunPollSummary) => Promise.all(s.started.map((x) => x.done));

test('lifecycle audit: claim → start → settle writes queued, started and done rows', async () => {
  const f = fakes({ rows: [row({ taskId: 't1' })] });
  const s = await pollTaskRunner(f.deps, { maxConcurrentRuns: 2 });
  await drain(s);

  assert.deepEqual(
    f.activity.map((a) => `${a.action}:${a.status}:${a.productStatus}`),
    ['chat_task.queued:in_progress:queued', 'chat_task.started:in_progress:running', 'chat_task.done:done:done'],
  );
  const [queued, started, done] = f.activity as [ChatTaskActivityEvent, ChatTaskActivityEvent, ChatTaskActivityEvent];
  // Every row identifies task + owning agent + the run it belongs to (the Activity view links
  // the run from details.runId and the agent from details.agentId).
  for (const a of [queued, started, done]) {
    assert.equal(a.companyId, C);
    assert.equal(a.agentId, A);
    assert.equal(a.chatTaskId, 't1');
    assert.ok(a.runId, 'the audit row carries the Run Task run id');
    assert.equal(a.title, 'Ship the runbook');
  }
  assert.equal(queued.previousStatus, 'pending'); // the stored CAS transition the claim made
  assert.equal(queued.attempts, 1);
  assert.equal(done.previousStatus, 'in_progress');
});

test('lifecycle audit: failed run with attempts left writes chat_task.error (product "error", stored pending)', async () => {
  const f = fakes({
    rows: [row({ taskId: 't1' })],
    wake: async (job) => ({ runId: job.runId ?? '', status: 'failed', errorText: 'boom' }),
  });
  const s = await pollTaskRunner(f.deps, { maxConcurrentRuns: 2, maxAttempts: 2 });
  await drain(s);

  const settleRow = f.activity.find((a) => a.action === 'chat_task.error');
  assert.ok(settleRow, 'the retry re-queue is audited as chat_task.error');
  assert.equal(settleRow!.status, 'pending'); // stored word (retry re-queue) …
  assert.equal(settleRow!.productStatus, 'error'); // … product word (the lifecycle map)
  assert.equal(settleRow!.previousStatus, 'in_progress');
  assert.equal(settleRow!.note, 'boom');
  assert.ok(!f.activity.some((a) => a.action === 'chat_task.parked' || a.action === 'chat_task.done'));
});

test('lifecycle audit: attempt-exhausted failure parks as chat_task.parked (stored waiting_on_user)', async () => {
  const f = fakes({
    rows: [row({ taskId: 't1', attempts: 1 })],
    wake: async (job) => ({ runId: job.runId ?? '', status: 'failed', errorText: 'dead' }),
  });
  const s = await pollTaskRunner(f.deps, { maxConcurrentRuns: 2, maxAttempts: 2 });
  await drain(s);

  const parked = f.activity.find((a) => a.action === 'chat_task.parked');
  assert.ok(parked);
  assert.equal(parked!.status, 'waiting_on_user');
  assert.equal(parked!.productStatus, 'error');
  assert.equal(parked!.note, 'dead');
  assert.equal(parked!.attempts, 2); // this run consumed the second attempt
});

test('skips write NO audit rows: paused, inactive and company-disabled never transition', async () => {
  const rows = [
    row({ taskId: 'p1', paused: true }),
    row({ taskId: 'i1', agentStatus: 'paused' }),
    row({ taskId: 'd1', companySettings: { taskRunner: { enabled: false } } }),
  ];
  const f = fakes({ rows });
  const s = await pollTaskRunner(f.deps, { maxConcurrentRuns: 2 });
  await drain(s);
  assert.deepEqual(f.activity, []);
  assert.ok(s.skippedInactive >= 1 && s.skippedDisabled >= 1);
});

test('audit is best-effort: a throwing logActivity seam never breaks the run', async () => {
  const f = fakes({ rows: [row({ taskId: 't1' })] });
  f.deps.logActivity = () => {
    throw new Error('activity db down');
  };
  const warns: string[] = [];
  f.deps.log = { info: () => undefined, warn: (m) => warns.push(m) };

  const s = await pollTaskRunner(f.deps, { maxConcurrentRuns: 2 });
  await drain(s);
  assert.equal(s.started.length, 1); // the task still ran
  assert.ok(warns.includes('task-run activity log failed'), 'the failed audit is logged, not swallowed');
});

test('taskRunSettleActivityAction maps the three settle outcomes onto the lifecycle actions', () => {
  assert.equal(taskRunSettleActivityAction('done'), 'chat_task.done');
  assert.equal(taskRunSettleActivityAction('pending'), 'chat_task.error');
  assert.equal(taskRunSettleActivityAction('waiting_on_user'), 'chat_task.parked');
});
