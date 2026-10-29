/**
 * #233 ACCEPT softs S233-S4 / S233-S6 / S233-S7 — TASK-RUNNER poller pack.
 *
 * S233-S4: the `task-run poll` per-tick summary line counted polled/started/deferred/
 *   inactive/disabled but DROPPED summary.skippedErrored — a quietly erroring agent
 *   (S199c per-agent isolation) was invisible in the tick log. The line now carries
 *   `errored`. Pinned with a deep-equal on the summary log payload: delete the field and
 *   these pins fail.
 *
 * S233-S6: the real-loop pins slept (11_500 ms / 50–60 ms) and HOPE the right number of
 *   ticks had fired when the clock advanced — slow, and flaky under load. startTaskRunnerPolling
 *   gained two seams: `intervalMs` (an explicit ms interval that bypasses the 5s production
 *   floor; production callers stay on intervalSec/env and keep the floor) and
 *   `poller.whenTicks(n)` (resolves once n ticks have COMPLETED, success or tick-level
 *   failure). Pinned here: exact tick counts in milliseconds, failure ticks still count
 *   (whenTicks never hangs on a throwing tick), and the kill switch resolves immediately.
 *   The rewritten 199b/199a/199c real-loop pins live in task-runner-199-softs.test.ts.
 *
 * S233-S7: deferLogMemory entries were only dropped when an agent got FREE SLOTS again
 *   (pollOneAgent). An agent that left the queue — tasks drained, cancelled, paused,
 *   inactive — kept its stamp forever (bounded leak) AND, if its queue refilled inside the
 *   quiet window, its next deferral was silenced even though its deferral history had
 *   reset. pollTaskRunner now also deletes entries for every agent absent from this tick's
 *   runnable groups (empty queue clears the whole Map). Pinned: leave clears the stamp so a
 *   refill inside the window is LOUD again (matching the S199b free-slot reset semantics),
 *   while a still-busy neighbour keeps its quiet window.
 *
 * S233-S1/S2/S3 (migrateUp idempotency, seed guard, live-run opt-in) are pins on the live
 * helpers, so they live in task-runner-199-softs.test.ts alongside the helpers themselves.
 * S233-S5 is Ops (rate-limit the failing-agent log noise) — skipped this pack by design.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { RunnableChatTaskRow } from '@tourbillon/db';
import {
  pollTaskRunner,
  startTaskRunnerPolling,
  type TaskRunnerDeps,
} from './task-runner';
import type { HeartbeatJobData } from '@tourbillon/shared';
import type { WakeResult } from './wake-runner';

// task-runner.ts imports @tourbillon/db at module load, which validates DATABASE_URL eagerly.
process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused';

const C = 'company-1';

function row(over: Partial<RunnableChatTaskRow> = {}): RunnableChatTaskRow {
  return {
    companyId: C,
    agentId: 'agent-1',
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

interface LogCall {
  level: 'info' | 'warn' | 'error';
  msg: string;
  data?: Record<string, unknown>;
}

function recordingLog() {
  const lines: LogCall[] = [];
  const push = (level: LogCall['level']) => (msg: string, data?: Record<string, unknown>) =>
    lines.push({ level, msg, data });
  const log = { info: push('info'), warn: push('warn'), error: push('error') };
  return { lines, log };
}

function fakes(opts: {
  rows: RunnableChatTaskRow[];
  slots?: Record<string, { total: number; task: number }>;
  throwOnCount?: (agentId: string) => Error | undefined;
  log?: TaskRunnerDeps['log'];
}) {
  const f = {
    claims: [] as string[],
    jobs: [] as HeartbeatJobData[],
    settles: [] as Array<{ taskId: string; status: string }>,
  };
  const deps: TaskRunnerDeps = {
    db: null as unknown as TaskRunnerDeps['db'],
    listRunnable: async () => opts.rows,
    countActiveRuns: async (agentId) => {
      const err = opts.throwOnCount?.(agentId);
      if (err) throw err;
      return opts.slots?.[agentId] ?? { total: 0, task: 0 };
    },
    claim: async (taskId) => {
      f.claims.push(taskId);
      return true;
    },
    startWake: async (job) => {
      f.jobs.push(job);
      return { runId: job.runId ?? '', status: 'succeeded' } as WakeResult;
    },
    settle: async (taskId, status) => {
      f.settles.push({ taskId, status });
    },
    log: opts.log,
  };
  return { deps, ...f };
}

const deferLines = (lines: LogCall[]) => lines.filter((l) => l.msg === 'task-run slots full, deferring');
const pollLines = (lines: LogCall[]) => lines.filter((l) => l.msg === 'task-run poll');

// ─── S233-S4 — the tick summary line carries `errored` ──────────────────────

test('S233-S4: the per-tick summary line includes errored=skippedErrored (real loop, payload deep-equal)', async () => {
  const { lines, log } = recordingLog();
  const rows = [
    row({ taskId: 't-bad', agentId: 'a-bad' }),
    row({ taskId: 't-good', agentId: 'a-good' }),
  ];
  const f = fakes({
    rows,
    slots: { 'a-good': { total: 0, task: 0 } },
    throwOnCount: (agentId) => (agentId === 'a-bad' ? new Error('db hiccup') : undefined),
    log,
  });
  const poller = startTaskRunnerPolling(f.deps, { intervalMs: 10, maxConcurrentRuns: 2, taskCap: 1 });
  await poller.whenTicks(); // S233-S6 seam doubles as the deterministic driver here
  poller.stop();

  const summaries = pollLines(lines);
  assert.equal(summaries.length, 1, 'one completed tick → one summary line');
  assert.deepEqual(
    summaries[0]!.data,
    { polled: 2, started: 1, deferred: 0, inactive: 0, disabled: 0, errored: 1 },
    'the tick line must surface per-agent isolation: errored is the summary.skippedErrored counter',
  );
});

test('S233-S4: an all-erroring tick still logs the summary (started=0, errored=2)', async () => {
  const { lines, log } = recordingLog();
  const rows = [
    row({ taskId: 't-1', agentId: 'a-1' }),
    row({ taskId: 't-2', agentId: 'a-2' }),
  ];
  const f = fakes({ rows, throwOnCount: () => new Error('db on fire'), log });
  const poller = startTaskRunnerPolling(f.deps, { intervalMs: 10, maxConcurrentRuns: 2, taskCap: 1 });
  await poller.whenTicks();
  poller.stop();

  const summaries = pollLines(lines);
  assert.equal(summaries.length, 1, 'polled > 0 keeps the summary line even when every agent errored');
  assert.deepEqual(
    summaries[0]!.data,
    { polled: 2, started: 0, deferred: 0, inactive: 0, disabled: 0, errored: 2 },
    'two erroring agents → errored=2, started=0',
  );
});

// ─── S233-S6 — intervalMs seam + whenTicks(n) ────────────────────────────────

test('S233-S6: whenTicks(3) at intervalMs=10 completes three REAL loop ticks in milliseconds', async () => {
  const { lines, log } = recordingLog();
  const f = fakes({
    rows: [row({ taskId: 't1', agentId: 'a1' })],
    slots: { a1: { total: 2, task: 1 } },
    log,
  });
  const t0 = Date.now();
  const poller = startTaskRunnerPolling(f.deps, { intervalMs: 10, maxConcurrentRuns: 2, taskCap: 1 });
  await poller.whenTicks(3);
  const elapsed = Date.now() - t0;
  poller.stop();

  assert.ok(elapsed < 2_000, `three completed ticks via intervalMs must take ms, got ${elapsed}ms (old pin slept 11_500ms)`);
  assert.equal(pollLines(lines).length, 3, 'exactly three completed ticks each logged a summary');
  assert.equal(deferLines(lines).length, 1, 'the S199b rate limit still holds across the fast ticks');
});

test('S233-S6: tick-level failures count as COMPLETED ticks — whenTicks never hangs on a throwing tick', async () => {
  const { lines, log } = recordingLog();
  const base = fakes({ rows: [] });
  const deps: TaskRunnerDeps = {
    ...base.deps,
    listRunnable: async () => {
      throw new Error('boom');
    },
    log,
  };
  const poller = startTaskRunnerPolling(deps, { intervalMs: 10 });
  await poller.whenTicks(2); // resolves only if the catch path still settles the tick
  poller.stop();

  assert.equal(lines.filter((l) => l.msg === 'task-run poll failed').length, 2);
});

test('S233-S6: the kill-switch poller resolves whenTicks immediately (no hang, no ticks)', async () => {
  const base = fakes({ rows: [row()] });
  const poller = startTaskRunnerPolling(base.deps, { maxConcurrentRuns: 0 });
  await poller.whenTicks(5); // a disabled poller never ticks; must resolve, not wait forever
  poller.stop();
});

// ─── S233-S7 — deferLogMemory entries drop when an agent LEAVES the queue ───

test('S233-S7: an agent that leaves the queue loses its defer-log stamp — refill inside the window is LOUD again', async () => {
  const { lines, log } = recordingLog();
  let rows: RunnableChatTaskRow[] = [row({ taskId: 't1', agentId: 'a1' })];
  const f = fakes({ rows, slots: { a1: { total: 2, task: 1 } }, log });
  f.deps.listRunnable = async () => rows;
  const mem = new Map<string, number>();
  const opts = { maxConcurrentRuns: 2, taskCap: 1, deferLogMemory: mem, now: () => 0 };

  await pollTaskRunner(f.deps, opts);
  assert.equal(mem.size, 1, 'deferral stamped');

  rows = []; // the queue emptied — a1 LEAVES
  const empty = await pollTaskRunner(f.deps, opts);
  assert.equal(empty.polled, 0);
  assert.equal(mem.size, 0, 'leaving the queue drops the entry (historic behaviour: stamp leaked forever)');

  rows = [row({ taskId: 't2', agentId: 'a1' })]; // refill — same clock, deep inside the quiet window
  await pollTaskRunner(f.deps, opts);
  assert.equal(deferLines(lines).length, 2,
    'leave → refill defers LOUD again inside the window: the deferral history reset with the queue ' +
    '(matches the S199b free-slot reset semantics)');
});

test('S233-S7: only agents absent from the tick lose their stamp — a still-busy neighbour keeps its quiet window', async () => {
  const { lines, log } = recordingLog();
  let rows: RunnableChatTaskRow[] = [
    row({ taskId: 't1', agentId: 'a1' }),
    row({ taskId: 't2', agentId: 'a2' }),
  ];
  const f = fakes({
    rows,
    slots: { a1: { total: 2, task: 1 }, a2: { total: 2, task: 1 } },
    log,
  });
  f.deps.listRunnable = async () => rows;
  const mem = new Map<string, number>();
  const opts = { maxConcurrentRuns: 2, taskCap: 1, deferLogMemory: mem, now: () => 0 };

  await pollTaskRunner(f.deps, opts);
  assert.deepEqual([...mem.keys()].sort(), ['a1', 'a2'], 'both busy agents stamped');

  rows = [row({ taskId: 't2', agentId: 'a2' })]; // a1 left; a2 is still deferred every tick
  await pollTaskRunner(f.deps, opts);
  assert.deepEqual([...mem.keys()], ['a2'], 'the departed agent is dropped; the busy one keeps its stamp');
  assert.equal(deferLines(lines).length, 2,
    'a2 stays quiet inside its window — leave-cleanup must not re-arm agents that never left');
});

test('S233-S7: an inactive/paused row is a LEAVE too — its stamp drops with it', async () => {
  const { log } = recordingLog();
  let rows: RunnableChatTaskRow[] = [row({ taskId: 't1', agentId: 'a1' })];
  const f = fakes({ rows, slots: { a1: { total: 2, task: 1 } }, log });
  f.deps.listRunnable = async () => rows;
  const mem = new Map<string, number>();
  const opts = { maxConcurrentRuns: 2, taskCap: 1, deferLogMemory: mem, now: () => 0 };

  await pollTaskRunner(f.deps, opts);
  assert.equal(mem.size, 1);

  rows = [row({ taskId: 't1', agentId: 'a1', paused: true })]; // row exists but never groups
  await pollTaskRunner(f.deps, opts);
  assert.equal(mem.size, 0, 'a fully-paused agent left the runnable queue — entry dropped');
});
