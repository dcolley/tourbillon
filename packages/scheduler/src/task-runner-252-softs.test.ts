/**
 * S252-S1 + S252-S2 (#252 ACCEPT soft-pack, info/harden): honesty pins around the cap-0
 * remedy copy and env-independence of the paused-skip poll test.
 *
 * S252-S1: the cap-0 refusal copy names two remedies — raise TASK_RUNNER_MAX_CONCURRENT_RUNS
 * to ≥ 2, or pass an explicit opts.taskCap ≥ 1. They are NOT equally reachable. The env half
 * is the ONLY knob the scheduler-main boot path can turn: main calls
 * boot.startTaskRunnerPolling() with ZERO args (and SchedulerBootDeps types the seam
 * `() => { stop(): void }`), so opts.taskCap is undefined on every main-shaped tick — it can
 * only arrive from call sites that pass explicit opts (embedded pollers, tools, tests). The
 * copy stays honest in BOTH directions: it must still name BOTH remedies (each is real to
 * SOME caller), and it must never claim the opts.taskCap half is reachable from scheduler-main
 * — a copy like "…have scheduler-main pass opts.taskCap" REDs here; the wiring half of the
 * claim is pinned by scheduler-main-252-softs.test.ts.
 *
 * S252-S2: task-runner.test.ts "paused tasks skip the queue even when slots are free" called
 * pollTaskRunner(f.deps, {}) — the opts-less form inherits the module-load
 * DEFAULT_MAX_CONCURRENT_RUNS, i.e. the REAL host env. Verified: under an env of 1 the test
 * does NOT flake today, because paused rows are filtered out of the agent grouping BEFORE any
 * cap is consulted (empty byAgent → early return). That isolation is a code ORDERING fact,
 * not a test-design fact — so the call now carries an explicit budget (S249-S2 pattern) and
 * the pin below freezes the ordering: a paused-only queue produces the identical summary at
 * budget 1 and budget 2. Moving the cap-0 check ahead of the paused filter (or dropping the
 * filter) makes the budget-1 arm RED.
 *
 * S256-S1/S2 (#256 ACCEPT soft-pack addendum): S1b above passes `maxConcurrentRuns: 1`
 * EXPLICITLY, so it is "main-shaped" only by coincidence — the LITERAL main path (zero opts,
 * budget inherited from TASK_RUNNER_MAX_CONCURRENT_RUNS=1 at module load) is pinned by
 * task-runner-256-softs.test.ts via a fresh child process; S1b stays for the opts-shape half.
 * S2 narrows the two anti-copy bans below from a bare /scheduler/i to the
 * taskCap↔boot-path-tie pattern (FORBIDDEN_TASKCAP_WIRING_CLAIM).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pollTaskRunner, startTaskRunnerPolling, type TaskRunnerDeps } from './task-runner';
import type { RunnableChatTaskRow } from '@tourbillon/db';
import type { HeartbeatJobData } from '@tourbillon/shared';
import type { WakeResult } from './wake-runner';

// task-runner.ts imports @tourbillon/db at module load, which validates DATABASE_URL eagerly.
process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1/unused';

function row(over: Partial<RunnableChatTaskRow> = {}): RunnableChatTaskRow {
  return {
    companyId: 'company-1',
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

interface Collector {
  warns: Array<{ msg: string; data?: Record<string, unknown> }>;
  claims: string[];
  jobs: HeartbeatJobData[];
}

function collectingDeps(rows: RunnableChatTaskRow[], c: Collector): TaskRunnerDeps {
  return {
    db: null as unknown as TaskRunnerDeps['db'],
    listRunnable: async () => rows,
    countActiveRuns: async () => ({ total: 0, task: 0 }),
    claim: async (taskId: string) => {
      c.claims.push(taskId);
      return true;
    },
    startWake: async (job: HeartbeatJobData) => {
      c.jobs.push(job);
      return { runId: job.runId ?? '', status: 'succeeded' } as WakeResult;
    },
    settle: async () => {},
    log: {
      info: () => {},
      warn: (msg: string, data?: Record<string, unknown>) => c.warns.push({ msg, data }),
    },
  } as unknown as TaskRunnerDeps;
}

const CAP_ZERO_REFUSAL = /task-run capacity zero, refusing/;

/**
 * S256-S2 (#256 ACCEPT soft-pack): the narrowed wiring-claim ban. The old pin used a bare
 * /scheduler/i, which is too broad — it REDs on legitimate future copy that merely
 * MENTIONS a scheduler ("see the scheduler log", "raised from the scheduler"), not on the
 * actual lie. What must stay forbidden is a copy that TIES `opts.taskCap` to the scheduler
 * boot path ("…or have scheduler-main pass opts.taskCap"), because main starts the poller
 * with ZERO args (wiring pinned by scheduler-main-252-softs.test.ts). The 60-char window
 * on each side is generous enough for natural connector words ("pass opts.taskCap through
 * the boot seam" ≈ 45 chars REDs; "pass an explicit opts.taskCap ≥ 1" — the real copy,
 * 63 chars to the nearest boot-path word — stays GREEN) while still catching the
 * plausible mutant wordings.
 */
const FORBIDDEN_TASKCAP_WIRING_CLAIM =
  /taskCap[\s\S]{0,60}\b(scheduler|main|boot)\b|\b(scheduler|main|boot)\b[\s\S]{0,60}taskCap/i;

// ─── S252-S1 ─────────────────────────────────────────────────────────────────

test('S252-S1a: cap-0 refusal names the env remedy and the opts-only remedy without claiming scheduler-main reachability', async () => {
  const c: Collector = { warns: [], claims: [], jobs: [] };
  // Budget 1 → defaultTaskCapPerAgent(1) = 0: the documented cap-0 shape, reached with NO
  // opts.taskCap anywhere (the scheduler-main-shaped opts surface: budget only).
  const s = await pollTaskRunner(collectingDeps([row()], c), { maxConcurrentRuns: 1 });
  assert.equal(s.skippedNoCapacity, 1, 'the refusal path itself must still fire');
  assert.deepEqual(c.claims, [], 'cap-0 never claims — attempt budget untouched');
  assert.deepEqual(c.jobs, [], 'cap-0 never reaches a wake');

  const refusal = c.warns.find((l) => CAP_ZERO_REFUSAL.test(l.msg));
  assert.ok(refusal, 'cap-0 still gets its honest refusal line');
  // Remedy 1: the ONLY knob reachable from scheduler-main (host env → module-load default
  // budget). Without this half the main-path operator has no remedy in the copy at all.
  assert.match(refusal.msg, /TASK_RUNNER_MAX_CONCURRENT_RUNS/, 'names the shared-budget env (the main-reachable remedy)');
  // Remedy 2: real, but ONLY for call sites that pass explicit opts (tools, embedded
  // pollers, tests) — never from main. Kept in the copy because those callers exist.
  assert.match(refusal.msg, /opts\.taskCap/, 'names the explicit override for opts-aware call sites');
  // Anti-copy claim: the copy must not suggest the opts.taskCap half is reachable from the
  // scheduler boot path. Copy like "…or have scheduler-main pass an explicit opts.taskCap"
  // (or any wording tying opts.taskCap to scheduler/main/boot) REDs here — the wiring side of
  // the same honesty is pinned by scheduler-main-252-softs.test.ts (main passes ZERO args).
  // S256-S2: narrowed from a bare /scheduler/i (which REDs on innocent copy merely MENTIONING
  // a scheduler) to the taskCap↔boot-path tie — see FORBIDDEN_TASKCAP_WIRING_CLAIM.
  assert.doesNotMatch(
    refusal.msg,
    FORBIDDEN_TASKCAP_WIRING_CLAIM,
    'the opts.taskCap remedy is intentionally tool/opts-only — the copy must not claim ' +
      'the boot path (which starts the poller with zero args) can pass it',
  );
});

test('S252-S1b: the main-shaped poller path (no opts.taskCap) still lands on the same honest refusal', async () => {
  // startTaskRunnerPolling with opts that a NO-ARGS scheduler-main call plus a budget-1
  // default produce: taskCap forwarded as undefined → derived cap 0. Pins that the refusal
  // the main-shaped tick actually prints keeps BOTH honest remedy halves — operators reading
  // the scheduler log see the env knob they can turn, and nothing claims main can pass opts.
  const c: Collector = { warns: [], claims: [], jobs: [] };
  const poller = startTaskRunnerPolling(collectingDeps([row()], c), {
    intervalMs: 20,
    maxConcurrentRuns: 1,
    // taskCap deliberately NOT passed — the main shape.
  });
  try {
    await poller.whenTicks(1);
  } finally {
    poller.stop();
  }
  const refusals = c.warns.filter((l) => CAP_ZERO_REFUSAL.test(l.msg));
  assert.ok(refusals.length >= 1, 'a main-shaped tick with budget 1 prints the refusal');
  for (const refusal of refusals) {
    assert.match(refusal.msg, /TASK_RUNNER_MAX_CONCURRENT_RUNS/, 'env remedy named');
    assert.match(refusal.msg, /opts\.taskCap/, 'opts-only remedy named');
    assert.doesNotMatch(
      refusal.msg,
      FORBIDDEN_TASKCAP_WIRING_CLAIM,
      'no claim that the boot path can pass opts.taskCap (narrowed from /scheduler/i, S256-S2)',
    );
  }
  assert.deepEqual(c.claims, [], 'the main-shaped cap-0 tick never claims a task');
});

// ─── S252-S2 ─────────────────────────────────────────────────────────────────

test('S252-S2: paused-only queue is cap-independent — identical summary at budget 1 and budget 2', async () => {
  // The :172 test in task-runner.test.ts runs exactly this shape (one paused row) via
  // pollTaskRunner(f.deps, {}), which inherits the module-load env default. Under a host
  // env of 1 it does not flake TODAY — paused rows leave byAgent empty and the tick returns
  // before any cap is consulted. That isolation is the ORDERING (paused filter before the
  // cap-0 check), so freeze the ordering directly: with budget 1 the budget-1 arm must NOT
  // fall into the cap-0 refusal. Delete `if (row.paused === true) continue;` (or move the
  // cap-0 check ahead of the grouping) and the budget-1 arm REDs with
  // skippedNoCapacity = 1 instead of 0.
  for (const maxConcurrentRuns of [2, 1]) {
    const c: Collector = { warns: [], claims: [], jobs: [] };
    const s = await pollTaskRunner(collectingDeps([row({ taskId: 't1', paused: true })], c), {
      maxConcurrentRuns,
    });
    assert.equal(s.polled, 1, `budget ${maxConcurrentRuns}: the row is still polled`);
    assert.equal(s.started.length, 0, `budget ${maxConcurrentRuns}: paused never starts`);
    assert.equal(s.skippedFull, 0, `budget ${maxConcurrentRuns}: not a budget deferral`);
    assert.equal(
      s.skippedNoCapacity,
      0,
      `budget ${maxConcurrentRuns}: a paused-only queue must not consult the cap — ` +
        'the cap-0 refusal is for QUEUED work, not filtered-out work',
    );
    assert.equal(s.skippedInactive, 0);
    assert.deepEqual(c.claims, [], `budget ${maxConcurrentRuns}: no claim, attempts untouched`);
    assert.deepEqual(c.jobs, [], `budget ${maxConcurrentRuns}: no wake`);
  }
});
