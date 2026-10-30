/**
 * S245-S3b (#245 ACCEPT soft-pack): cap-0 must REFUSE visibly, never queue silently forever.
 *
 * Two zero-capacity shapes left the Run Task queue as a silent forever-queue (OOS on #245):
 *
 *  1. TASK_RUNNER_MAX_CONCURRENT_RUNS=0 (global kill switch): the poller never starts, so
 *     every queued chat_task sits `pending` indefinitely. It logged one bare `info` line —
 *     routine-startup noise where nobody was looking while agents kept telling humans work
 *     was "queued for Run Task".
 *  2. Effective task cap 0 (shared budget 1 → defaultTaskCapPerAgent reserves the only slot
 *     for the heartbeat side; or an explicit opts.taskCap = 0): the poller ticks, but every
 *     agent with queued work lands in the `free <= 0` branch forever, mislabelled as a
 *     routine "task-run slots full, deferring" budget deferral — while no freed slot could
 *     EVER admit a task run.
 *
 * The fix (task-runner.ts): (1) the kill switch logs the exported RUN_TASK_KILL_SWITCH_LOG
 * at warn (info only as fallback) naming the env + the remedy; (2) cap-0 agents get their own
 * skippedNoCapacity counter + an honest "capacity zero, refusing" warn, and stop masquerading
 * as skippedFull. Still no claim, no attempt burn — refuse, don't silently queue.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pollTaskRunner,
  RUN_TASK_KILL_SWITCH_LOG,
  startTaskRunnerPolling,
  type TaskRunPollSummary,
  type TaskRunnerDeps,
} from './task-runner';
import type { RunnableChatTaskRow } from '@tourbillon/db';
import type { HeartbeatJobData } from '@tourbillon/shared';
import type { WakeResult } from './wake-runner';

// task-runner.ts imports @tourbillon/db at module load, which validates DATABASE_URL eagerly.
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

interface Fakes {
  deps: TaskRunnerDeps;
  claims: Array<{ taskId: string }>;
  jobs: HeartbeatJobData[];
  settles: Array<{ taskId: string; status: string }>;
  infos: Array<{ msg: string; data?: Record<string, unknown> }>;
  warns: Array<{ msg: string; data?: Record<string, unknown> }>;
}

function fakes(opts: { rows: RunnableChatTaskRow[]; slots?: { total: number; task: number } }): Fakes {
  const f: Fakes = {
    deps: null as unknown as TaskRunnerDeps,
    claims: [],
    jobs: [],
    settles: [],
    infos: [],
    warns: [],
  };
  f.deps = {
    db: null as unknown as TaskRunnerDeps['db'],
    listRunnable: async () => opts.rows,
    countActiveRuns: async () => opts.slots ?? { total: 0, task: 0 },
    claim: async (taskId) => {
      f.claims.push({ taskId });
      return true;
    },
    startWake: async (job) => {
      f.jobs.push(job);
      return { runId: job.runId ?? '', status: 'succeeded' } as WakeResult;
    },
    settle: async (taskId, status) => {
      f.settles.push({ taskId, status });
    },
    log: {
      info: (msg, data) => f.infos.push({ msg, data }),
      warn: (msg, data) => f.warns.push({ msg, data }),
    },
  };
  return f;
}

// ─── (1) global kill switch: loud warn naming the env + remedy ───────────────

test('S245-S3b: kill switch logs the KILL SWITCH message at WARN (not info noise)', () => {
  const f = fakes({ rows: [row({ taskId: 't1' })] });
  const poller = startTaskRunnerPolling(f.deps, { maxConcurrentRuns: 0 });
  poller.stop();
  assert.deepEqual(
    f.infos,
    [],
    'a halted queue must not hide at info level — the old silent-forever bug was an info line',
  );
  assert.equal(f.warns.length, 1, 'exactly one loud warn at startup');
  assert.equal(f.warns[0]!.msg, RUN_TASK_KILL_SWITCH_LOG);
  assert.match(RUN_TASK_KILL_SWITCH_LOG, /KILL SWITCH/, 'names the mode, not just "disabled"');
  assert.match(
    RUN_TASK_KILL_SWITCH_LOG,
    /queued Run Tasks will NOT\s*start/i,
    'says plainly that the queue is frozen, not merely that a poller is off',
  );
  assert.match(
    RUN_TASK_KILL_SWITCH_LOG,
    /TASK_RUNNER_MAX_CONCURRENT_RUNS/,
    'names the env the operator has to raise',
  );
});

test('S245-S3b: kill switch still logs (info fallback) for deps without warn', () => {
  const infos: string[] = [];
  const f = fakes({ rows: [row({ taskId: 't1' })] });
  const poller = startTaskRunnerPolling(
    { ...f.deps, log: { info: (msg) => infos.push(msg) } },
    { maxConcurrentRuns: 0 },
  );
  poller.stop();
  assert.deepEqual(infos, [RUN_TASK_KILL_SWITCH_LOG], 'warn-absent deps must not lose the line');
});

// ─── (2) effective task cap 0: refuse with its own counter, never skippedFull ─

for (const [label, opts] of [
  ['explicit opts.taskCap = 0', { maxConcurrentRuns: 4, taskCap: 0 }],
  ['shared budget 1 (heartbeat reservation leaves 0)', { maxConcurrentRuns: 1 }],
] as const) {
  test(`S245-S3b: taskCap 0 via ${label} → refused, counted, honest warn — never claimed`, async () => {
    const f = fakes({ rows: [row({ taskId: 't1' }), row({ taskId: 't2', position: 1 })] });
    const s = await pollTaskRunner(f.deps, opts);
    assert.equal(s.started.length, 0, 'cap 0 starts nothing');
    assert.deepEqual(f.claims, [], 'refuse means NO claim — attempt budget stays intact');
    assert.deepEqual(f.jobs, []);
    assert.deepEqual(f.settles, []);
    assert.equal(s.skippedNoCapacity, 1, 'own counter, distinct from routine budget deferrals');
    assert.equal(s.skippedFull, 0, 'a structurally-zero cap must not masquerade as "slots full"');
    const refusal = f.warns.find((l) => /task-run capacity zero, refusing/.test(l.msg));
    assert.ok(refusal, 'an honest refusal line names capacity-zero, not a lying deferral');
    assert.match(refusal!.msg, /TASK_RUNNER_MAX_CONCURRENT_RUNS/, 'names the budget env');
    assert.equal(refusal!.data?.agentId, A);
    assert.equal(refusal!.data?.taskCap, 0, 'the refused data carries the zero cap for triage');
    // The deferral lie is gone entirely for this shape:
    assert.equal(
      f.infos.filter((l) => /task-run slots full, deferring/.test(l.msg)).length,
      0,
      'cap-0 must never be reported as a transient "slots full" deferral',
    );
  });
}

test('S245-S3b: cap-0 refusal is rate-limited per agent like the deferral line', async () => {
  const f = fakes({ rows: [row({ taskId: 't1' })] });
  const mem = new Map<string, number>();
  const s1 = await pollTaskRunner(f.deps, { maxConcurrentRuns: 1, deferLogMemory: mem, now: () => 0 });
  const s2 = await pollTaskRunner(f.deps, { maxConcurrentRuns: 1, deferLogMemory: mem, now: () => 60_000 });
  assert.equal(s1.skippedNoCapacity, 1);
  assert.equal(s2.skippedNoCapacity, 1, 'the counter ticks every tick — only the LOG is rate-limited');
  assert.equal(
    f.warns.filter((l) => /task-run capacity zero, refusing/.test(l.msg)).length,
    1,
    'first refusal loud, repeats inside the quiet window silent (no 30s log flood)',
  );
});

test('S245-S3b: a genuinely-full budget still counts skippedFull (noCapacity stays 0)', async () => {
  // Guard against the branch swallowing the normal deferral path: budget 2, both slots busy,
  // taskCap 1 — this is transient and must keep its historic accounting.
  const f = fakes({ rows: [row({ taskId: 't1' })], slots: { total: 2, task: 0 } });
  // S249-S2: budget pinned, not inherited from the host env. DEFAULT_MAX_CONCURRENT_RUNS is
  // resolved at module load, so a host TASK_RUNNER_MAX_CONCURRENT_RUNS=1 would silently flip
  // this "genuinely full budget" scenario into the cap-0 branch (skippedFull 1 → 0).
  const s: TaskRunPollSummary = await pollTaskRunner(f.deps, { maxConcurrentRuns: 2 });
  assert.equal(s.skippedFull, 1);
  assert.equal(s.skippedNoCapacity, 0);
  assert.equal(f.warns.filter((l) => /capacity zero/.test(l.msg)).length, 0);
});

test('S245-S3b: per-tick poll summary surfaces noCapacity', async () => {
  const f = fakes({ rows: [row({ taskId: 't1' })] });
  const poller = startTaskRunnerPolling(f.deps, { maxConcurrentRuns: 1, intervalMs: 1 });
  try {
    await poller.whenTicks(1);
  } finally {
    poller.stop();
  }
  const tick = f.infos.find((l) => l.msg === 'task-run poll');
  assert.ok(tick, 'polled>0 must still print the tick summary');
  assert.equal(tick!.data?.noCapacity, 1, 'the frozen-queue reason is visible in the per-tick line');
});
