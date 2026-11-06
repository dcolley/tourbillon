/**
 * #338 — the harness (`AgentController`) dying before its promise settles must never leave a
 * silent hole: the poller races every Run Task wake against the settle guard (a hung promise
 * yields a PRECISE failure instead of a hang the stale sweeps later lose-park), terminal parks
 * carry the honest `failure:` notes line (#340), and the scheduler process survives stray
 * unhandled rejections instead of taking every in-flight run down with them.
 *
 * Same fake-deps harness as task-runner-258.test.ts — no database, no model.
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  pollTaskRunner,
  resolveWakeSettleGuardSec,
  wakeSettleGuardErrorText,
  WAKE_SETTLE_GUARD_DEFAULT_SEC,
  type TaskRunPollSummary,
  type TaskRunnerDeps,
} from './task-runner';
import type { RunnableChatTaskRow } from '@tourbillon/db';
import type { HeartbeatJobData } from '@tourbillon/shared';
import type { WakeResult } from './wake-runner';

process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused';

// scheduler-main → wake-server → wake-runner → redis-pub eagerly creates a real ioredis
// client at module load (`export const redisPub = createConnection()`). Nothing in these
// tests publishes (the guards under test only touch process listeners), but that client
// would reconnect forever and keep the test process alive after the assertions settle —
// the exact class of hang that orphaned the previous CONTINUE run's unit tree. Same
// require-cache stub as scheduler-main.test.ts: the rest of the graph loads for real while
// no socket is ever opened, and scheduler-main itself is loaded dynamically AFTER seeding.
const fakeRedisClient = {
  publish: async () => 0,
  quit: async () => 'OK' as const,
  disconnect: () => undefined,
  on: () => fakeRedisClient,
};
{
  const require_ = createRequire(import.meta.url);
  const redisPath = require_.resolve('./redis');
  const stub = {
    id: redisPath,
    filename: redisPath,
    loaded: true,
    exports: { createConnection: () => fakeRedisClient, connection: fakeRedisClient },
    children: [],
    paths: [],
  } as unknown as NodeJS.Require['cache'][string];
  require_.cache[redisPath] = stub;
}

let installSchedulerProcessGuards!: typeof import('./scheduler-main').installSchedulerProcessGuards;

before(async () => {
  ({ installSchedulerProcessGuards } = await import('./scheduler-main'));
});

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

interface SettleCall {
  taskId: string;
  status: 'pending' | 'waiting_on_user' | 'done';
  note?: string;
}

function fakes(opts: {
  rows: RunnableChatTaskRow[];
  wake?: (job: HeartbeatJobData) => Promise<WakeResult>;
}): { deps: TaskRunnerDeps; settles: SettleCall[] } {
  const settles: SettleCall[] = [];
  const deps: TaskRunnerDeps = {
    db: null as unknown as TaskRunnerDeps['db'],
    listRunnable: async () => opts.rows,
    countActiveRuns: async () => ({ total: 0, task: 0 }),
    claim: async () => true,
    startWake: async (job) =>
      opts.wake ? opts.wake(job) : { runId: job.runId ?? '', status: 'succeeded' },
    settle: async (taskId, status, note) => {
      settles.push({ taskId, status, note });
    },
  };
  return { deps, settles };
}

const drain = (s: TaskRunPollSummary) => Promise.all(s.started.map((x) => x.done));

// ─── settle guard (#338) ─────────────────────────────────────────────────────

test('resolveWakeSettleGuardSec: default sits above the max harness wall-clock; garbage falls back', () => {
  assert.equal(resolveWakeSettleGuardSec(undefined), WAKE_SETTLE_GUARD_DEFAULT_SEC);
  assert.ok(
    WAKE_SETTLE_GUARD_DEFAULT_SEC > 23 * 3600,
    'the deadline must exceed the 23h harness cap or legit long runs get cut off',
  );
  assert.equal(resolveWakeSettleGuardSec(''), WAKE_SETTLE_GUARD_DEFAULT_SEC);
  assert.equal(resolveWakeSettleGuardSec('garbage'), WAKE_SETTLE_GUARD_DEFAULT_SEC);
  assert.equal(resolveWakeSettleGuardSec('0'), WAKE_SETTLE_GUARD_DEFAULT_SEC);
  assert.equal(resolveWakeSettleGuardSec('-5'), WAKE_SETTLE_GUARD_DEFAULT_SEC);
  assert.equal(resolveWakeSettleGuardSec('600'), 600);
  assert.equal(resolveWakeSettleGuardSec('600.7'), 600, 'truncated, never a fractional surprise');
});

test('#338: a wake whose promise never settles is settled as failed by the guard (precise text)', async () => {
  // The promise-dies shape: startWake NEVER resolves — no resolve, no reject, nothing.
  const f = fakes({
    rows: [row({ taskId: 't-hang' })],
    wake: () => new Promise<WakeResult>(() => undefined),
  });
  // The guard timer is deliberately unref'd (a 23h timer must not hold the loop at shutdown;
  // in production the poller's own interval keeps it alive so the guard still fires). In a
  // bare test process nothing else is alive, so hold the loop here while the unref'd timer
  // runs — the exact invariant the poller interval provides in production.
  const keepAlive = setInterval(() => undefined, 50);
  let s: TaskRunPollSummary;
  try {
    s = await pollTaskRunner(f.deps, { maxConcurrentRuns: 2, wakeSettleGuardSec: 0.01 });
    await drain(s); // would hang forever without the guard
  } finally {
    clearInterval(keepAlive);
  }

  assert.equal(f.settles.length, 1, 'the hung wake was settled by the guard');
  const [call] = f.settles;
  assert.equal(call!.status, 'pending', 'attempt 1 of 2 → normal retry path (guard changes nothing else)');
  assert.ok(
    call!.note!.includes('did not settle within'),
    `guard names itself: ${call!.note}`,
  );
  assert.ok(call!.note!.includes('controller promise died before settling'));
});

test('#338: the guard never cuts off a wake that settles in time (both outcomes)', async () => {
  const f = fakes({
    rows: [row({ taskId: 't-fast' })],
    wake: async (job) => ({ runId: job.runId ?? '', status: 'succeeded' }),
  });
  const s = await pollTaskRunner(f.deps, { maxConcurrentRuns: 2, wakeSettleGuardSec: 0.01 });
  await drain(s);
  assert.deepEqual(f.settles.map((c) => c.status), ['done'], 'a fast wake is untouched by the guard');
});

// ─── #340 park honesty (runner side) ─────────────────────────────────────────

test('#340: an attempt-exhausted park settles with a `failure:` line, never a fake ask', async () => {
  const f = fakes({
    rows: [row({ taskId: 't-park', attempts: 1 })],
    wake: async (job) => ({ runId: job.runId ?? '', status: 'failed', errorText: 'dead' }),
  });
  const s = await pollTaskRunner(f.deps, { maxConcurrentRuns: 2, maxAttempts: 2 });
  await drain(s);
  const [call] = f.settles;
  assert.equal(call!.status, 'waiting_on_user');
  assert.match(call!.note!, /^failure: \[runner\] Run Task parked as a runner FAILURE \(wake failed: dead\) — not a user-input ask\.$/);
  assert.ok(!call!.note!.includes('ask: '), 'no user-facing ask may hide in a park note');
});

test('#340: a skipped wake parked past the budget is also honest (coalesced skipped shape)', async () => {
  const f = fakes({
    rows: [row({ taskId: 't-skip', attempts: 1 })],
    wake: async (job) => ({ runId: job.runId ?? '', status: 'skipped' }),
  });
  const s = await pollTaskRunner(f.deps, { maxConcurrentRuns: 2, maxAttempts: 2 });
  await drain(s);
  const [call] = f.settles;
  assert.equal(call!.status, 'waiting_on_user');
  assert.match(call!.note!, /^failure: \[runner\] Run Task parked as a runner FAILURE \(wake skipped\) — not a user-input ask\.$/);
});

test('#340: a RETRY re-queue keeps the plain errorText (not a park — no failure prefix needed)', async () => {
  const f = fakes({
    rows: [row({ taskId: 't-retry' })],
    wake: async (job) => ({ runId: job.runId ?? '', status: 'failed', errorText: 'boom' }),
  });
  const s = await pollTaskRunner(f.deps, { maxConcurrentRuns: 2, maxAttempts: 2 });
  await drain(s);
  assert.deepEqual(f.settles.map((c) => [c.status, c.note]), [['pending', 'boom']]);
});

test('#338 guard text is stable for operators (exported helper pin)', () => {
  assert.equal(
    wakeSettleGuardErrorText(600),
    'Run Task wake did not settle within 600s (harness settle guard — the controller promise died before settling); treating as failed',
  );
});

// ─── #338 process guards ─────────────────────────────────────────────────────

/**
 * #338: manually emitting unhandledRejection/uncaughtException on `process` would ALSO hit the
 * node:test runner's own listeners, which attribute the event to the running test and kill it.
 * Pass the listeners that existed BEFORE the guard install; they are unregistered for the
 * duration of each emit, so only the guard under test sees the event (and, post-dispose, nobody
 * does — which is exactly what the disposer assertion proves).
 */
type ProcessEvent = 'unhandledRejection' | 'uncaughtException';

function emitToGuardsOnly(
  event: ProcessEvent,
  foreign: Array<(arg: never, ...rest: never[]) => void>,
  ...args: unknown[]
): void {
  // One cast: with `event` a union the typed on/removeListener overloads cannot resolve.
  const p = process as unknown as {
    on: (e: string, l: (...a: never[]) => void) => unknown;
    removeListener: (e: string, l: (...a: never[]) => void) => unknown;
    emit: (e: string, ...a: unknown[]) => boolean;
  };
  for (const l of foreign) p.removeListener(event, l);
  try {
    p.emit(event, ...args);
  } finally {
    for (const l of foreign) p.on(event, l);
  }
}

test('#338: scheduler survives a stray unhandledRejection but logs it LOUDLY; uncaughtException logs then exits', async () => {
  const logged: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
  const logger = {
    info: (msg: string, data?: Record<string, unknown>) => logged.push({ level: 'info', msg, data }),
    warn: (msg: string, data?: Record<string, unknown>) => logged.push({ level: 'warn', msg, data }),
    error: (msg: string, data?: Record<string, unknown>) => logged.push({ level: 'error', msg, data }),
  };
  // Snapshot runner-internal listeners BEFORE the guard install (see emitToGuardsOnly).
  const foreign = {
    unhandledRejection: process.listeners('unhandledRejection') as Array<
      (arg: never, ...rest: never[]) => void
    >,
    uncaughtException: process.listeners('uncaughtException') as Array<
      (arg: never, ...rest: never[]) => void
    >,
  };
  const dispose = installSchedulerProcessGuards(logger as never);
  try {
    // An unhandled rejection must NOT crash the tick-based scheduler (#338 worker-died path).
    const doomed = Promise.reject(new Error('harness-internal boom'));
    await (async () => {
      try {
        await doomed;
      } catch {
        /* swallow our own await; the guard still sees the emitted event below */
      }
    })();
    emitToGuardsOnly('unhandledRejection', foreign.unhandledRejection, new Error('harness-internal boom'), doomed);
    await new Promise((r) => setImmediate(r));
    const rejection = logged.find((l) => l.msg.includes('unhandled rejection kept alive'));
    assert.ok(rejection, `expected the kept-alive line, got ${JSON.stringify(logged.map((l) => l.msg))}`);
    assert.equal(rejection!.level, 'error', 'a harness fault is never silent noise');
    assert.equal((rejection!.data as { error: string }).error, 'harness-internal boom');

    // uncaughtException keeps Node's crash semantics — but only after the log line. Stub exit.
    const realExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      return undefined as never;
    }) as typeof process.exit;
    try {
      emitToGuardsOnly('uncaughtException', foreign.uncaughtException, new Error('controller died mid-loop'));
    } finally {
      process.exit = realExit;
    }
    assert.equal(exitCode, 1, 'uncaughtException exits(1) for the supervisor');
    const exc = logged.find((l) => l.msg.includes('uncaught exception; exiting'));
    assert.ok(exc, 'and the cause reaches the scheduler log');
    assert.equal((exc!.data as { error: string }).error, 'controller died mid-loop');
  } finally {
    dispose();
  }
  // Disposer really removes: a post-dispose emit must not hit our logger again.
  const before = logged.length;
  emitToGuardsOnly('unhandledRejection', foreign.unhandledRejection, new Error('after dispose'), Promise.resolve());
  await new Promise((r) => setImmediate(r));
  assert.equal(
    logged.filter((l) => l.msg.includes('unhandled rejection kept alive')).length,
    1,
    'the disposer removed the listener (no double-install across boots)',
  );
  void before;
});
