/**
 * TASK-RUNNER unit tests — the shared per-agent run budget and the Run Task queue rules,
 * driven against fake TaskRunnerDeps (no database, no model). The poller gates tasks
 * through the SAME slot pool heartbeats use (one per-agent budget, not a second unlimited
 * runner); paused and attempt-exhausted tasks never enqueue; a task that waits for a slot
 * keeps its attempt budget; a task wake is a different KIND of job (no issue taskId).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
  buildTaskRunWake,
  countActiveRuns,
  createDefaultTaskRunnerDeps,
  defaultTaskCapPerAgent,
  freeTaskRunSlots,
  pollTaskRunner,
  resolveMaxConcurrentRuns,
  startTaskRunnerPolling,
  taskRunSettleStatus,
  type TaskRunPollSummary,
  type TaskRunSlotState,
  type TaskRunnerDeps,
} from './task-runner';
import { buildWakeMessageWithStats } from '@tourbillon/shared';
import type { RunnableChatTaskRow } from '@tourbillon/db';
import type { ChatTaskDb } from '@tourbillon/db';
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
  claims: Array<{ taskId: string; runId: string }>;
  /** Claim calls with the per-group attempt budget the poller resolved (S1). */
  claimBudgets: Array<{ taskId: string; maxAttempts: number }>;
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
    claimBudgets: [],
    jobs: [],
    settles: [],
    progress: [],
  };
  f.deps = {
    db: null as unknown as TaskRunnerDeps['db'],
    listRunnable: async () => opts.rows,
    countActiveRuns: async () => opts.slots ?? { total: 0, task: 0 },
    claim: async (taskId, runId, maxAttempts) => {
      f.claims.push({ taskId, runId });
      f.claimBudgets.push({ taskId, maxAttempts });
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

// ─── S1 (#196 follow-up): companies.settings.taskRunner is LIVE ───────────────
// enabled / maxConcurrentTasks / maxAttemptsPerTask are resolved per company by the poller
// (resolveTaskRunnerSettings), never dead config. TASK_RUNNER_MAX_CONCURRENT_RUNS=0 is the
// global kill switch.

test('S1: company taskRunner.enabled=false rows skip the queue BEFORE claim (B1 discipline)', async () => {
  // Free slots — the ONLY thing stopping t-off is the company switch. It must not even be
  // claimed (claim burns runner_attempts; a disabled company's rows stay untouched pending).
  const rows = [
    row({ taskId: 't-off', companySettings: { taskRunner: { enabled: false } } }),
    row({ taskId: 't-on', position: 1 }),
  ];
  const f = fakes({ rows, slots: { total: 0, task: 0 } });
  const s = await pollTaskRunner(f.deps, {});
  assert.equal(s.polled, 2);
  assert.equal(s.skippedDisabled, 1);
  assert.equal(s.skippedInactive, 0); // disabled is its own bucket, not "inactive"
  assert.deepEqual(f.claims.map((c) => c.taskId), ['t-on']);
  await drain(s);
  assert.deepEqual(f.settles, [{ taskId: 't-on', status: 'done' }]);
});

test('S1: a garbage settings block falls back to defaults (enabled, cap 2, attempts 2)', async () => {
  // jsonb is free-form: strings, arrays, nonsense — the poller must treat it as "not disabled".
  const rows = [row({ taskId: 't-garbage', companySettings: 'not-an-object' }), row({ taskId: 't-null', companySettings: null })];
  const f = fakes({ rows, slots: { total: 0, task: 0 } });
  // Budget 4: with no opts.taskCap the combined cap is min(company 2, budget-1) — at the
  // default budget of 2 the S3 heartbeat reservation would allow only ONE task run (see the
  // S3 reservation tests), which would mask what this test actually asserts: a garbage/null
  // settings block falls back to enabled with attempts 2.
  const s = await pollTaskRunner(f.deps, { maxConcurrentRuns: 4 });
  assert.equal(s.skippedDisabled, 0);
  assert.deepEqual(f.claims.map((c) => c.taskId), ['t-garbage', 't-null']);
  assert.deepEqual(f.claimBudgets.map((b) => b.maxAttempts), [2, 2]);
  await drain(s);
});

test('S1: company maxConcurrentTasks caps task runs per agent inside the shared budget', async () => {
  // Budget has room for 4, but the company capped itself at 1 concurrent task per agent.
  const rows = [
    row({ taskId: 't1', position: 0, companySettings: { taskRunner: { maxConcurrentTasks: 1 } } }),
    row({ taskId: 't2', position: 1, companySettings: { taskRunner: { maxConcurrentTasks: 1 } } }),
    row({ taskId: 't3', position: 2, companySettings: { taskRunner: { maxConcurrentTasks: 1 } } }),
  ];
  const f = fakes({ rows, slots: { total: 0, task: 0 } });
  const s = await pollTaskRunner(f.deps, { maxConcurrentRuns: 4 }); // no opts.taskCap → company wins
  assert.equal(s.started.length, 1);
  assert.equal(f.jobs[0]!.chatTaskId, 't1'); // claim order preserved
  assert.equal(s.skippedFull, 0); // cap ≠ full budget — this is a company clamp, not a deferral
  await drain(s);
});

test('S1: opts.taskCap / opts.maxAttempts overrides win over company settings', async () => {
  const rows = [
    row({ taskId: 't1', position: 0, companySettings: { taskRunner: { maxConcurrentTasks: 8 } } }),
    row({ taskId: 't2', position: 1, companySettings: { taskRunner: { maxConcurrentTasks: 8 } } }),
  ];
  const f = fakes({ rows, slots: { total: 0, task: 0 } });
  const s = await pollTaskRunner(f.deps, { maxConcurrentRuns: 8, taskCap: 1, maxAttempts: 1 });
  assert.equal(s.started.length, 1);
  assert.deepEqual(f.claimBudgets.map((b) => b.maxAttempts), [1]);
  await drain(s);
});

test('S1: company maxAttemptsPerTask drives the claim budget and the park decision', async () => {
  const fail = (job: HeartbeatJobData) =>
    Promise.resolve({ runId: job.runId ?? '', status: 'failed' as const, errorText: 'boom' });

  // attempts=2 used. Default budget (2) parks after the next failure; budget 4 re-queues.
  const strict = fakes({ rows: [row({ taskId: 't-strict', attempts: 2 })], wake: fail });
  const s1 = await pollTaskRunner(strict.deps, {});
  await drain(s1);
  assert.deepEqual(strict.settles, [{ taskId: 't-strict', status: 'waiting_on_user' }]);

  const generous = fakes({
    rows: [row({ taskId: 't-gen', attempts: 2, companySettings: { taskRunner: { maxAttemptsPerTask: 4 } } })],
    wake: fail,
  });
  const s2 = await pollTaskRunner(generous.deps, {});
  await drain(s2);
  assert.deepEqual(generous.claimBudgets, [{ taskId: 't-gen', maxAttempts: 4 }]);
  assert.deepEqual(generous.settles, [{ taskId: 't-gen', status: 'pending' }]); // 3 < 4 → fresh attempt
});

test('S1: resolveMaxConcurrentRuns — 0 is the kill switch, garbage falls back to 2', () => {
  assert.equal(resolveMaxConcurrentRuns('0'), 0); // explicit kill switch
  assert.equal(resolveMaxConcurrentRuns('2'), 2);
  assert.equal(resolveMaxConcurrentRuns('3.7'), 3);
  assert.equal(resolveMaxConcurrentRuns(undefined), 2);
  assert.equal(resolveMaxConcurrentRuns(''), 2); // blank ≠ 0 — blank is "unset"
  assert.equal(resolveMaxConcurrentRuns('   '), 2);
  assert.equal(resolveMaxConcurrentRuns('abc'), 2);
  assert.equal(resolveMaxConcurrentRuns('-1'), 2); // negative is garbage, NOT the switch
});

test('S1: maxConcurrentRuns=0 stops the poller BEFORE it polls', async () => {
  let listed = 0;
  const base = fakes({ rows: [row({ taskId: 't1' })] });
  const logs: string[] = [];
  const deps: TaskRunnerDeps = {
    ...base.deps,
    listRunnable: async () => {
      listed += 1;
      return [];
    },
    log: { info: (msg) => logs.push(msg) },
  };
  const poller = startTaskRunnerPolling(deps, { maxConcurrentRuns: 0 });
  poller.stop(); // stop() must be safe on a poller that never started
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(listed, 0, 'kill switch: not even one listRunnable call');
  assert.deepEqual(logs, ['task-run poller disabled (max concurrent runs = 0)']);
});

// HOTFIX regression (post-#196, TEST 28 Oct): countActiveRuns interpolated the staleCutoff Date
// into a raw sql`... >= ${staleCutoff}` template. Because this repo's postgres-js client runs
// with prepare:false, drizzle hands (sqlString, params) straight to client.unsafe() — and the
// raw Date in params is what Node's string-argument check rejected with ERR_INVALID_ARG_TYPE on
// every pollTaskRunner tick, so pending chat_tasks sat at pending / runner_attempts=0 forever.
// The fix (drizzle gte, same style as wake-runner's lt(lastSeenAt, cutoff)) makes the column's
// timestamp serializer emit an ISO string. This test drives the REAL drizzle→postgres-js
// boundary with a fake client, replicating the driver's parameter type gate.
test('countActiveRuns: driver boundary never sees a raw Date — cutoff arrives pre-serialised as a string', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  // drizzle mapResultRow reads row[columnIndex] — raw rows are arrays in SELECT order.
  const rows = [['timer'], ['task']];
  const fakePgClient = {
    options: { parsers: {}, serializers: {}, types: {} },
    PostgresError: class PostgresError extends Error {},
    END: {},
    listen: () => () => {},
    // prepare:false (packages/db/src/client.ts) routes every drizzle query through unsafe().
    unsafe(query: string, params: unknown[]) {
      calls.push({ sql: query, params });
      for (const p of params ?? []) {
        if (p !== null && !(typeof p === 'string' || typeof p === 'number' || typeof p === 'boolean')) {
          const err: any = new TypeError(
            `The "string" argument must be of type string. Received ${p instanceof Date ? 'an instance Date' : 'an instance of ' + (p?.constructor?.name ?? typeof p)}`,
          );
          err.code = 'ERR_INVALID_ARG_TYPE';
          throw err; // exactly what postgres.js + Node raised on TEST for the Date cutoff
        }
      }
      const promise = Promise.resolve(rows) as Promise<unknown> & {
        values: () => Promise<unknown>;
      };
      promise.values = () => Promise.resolve(rows);
      return promise;
    },
  };
  const database = drizzle(fakePgClient as never, { schema: {} as never }) as unknown as ChatTaskDb;

  // The regression proper: the buggy raw-Date param used to throw here every tick.
  const slot = await countActiveRuns(database, A);
  assert.deepEqual(slot, { total: 2, task: 1 }); // both kinds count toward the shared budget

  assert.equal(calls.length, 1);
  const { sql: emitted, params } = calls[0]!;
  // The fix: lastSeenAt goes through gte → a $n placeholder with a pre-serialised ISO string.
  assert.match(
    emitted,
    /"heartbeat_runs"\."last_seen_at" is null or "heartbeat_runs"\."last_seen_at" >= \$\d+/,
  );
  assert.ok(
    !/\bDate\b/.test(emitted),
    `raw Date leaked into SQL text: ${emitted}`,
  );
  assert.ok(
    params.every((p) => p === null || ['string', 'number', 'boolean'].includes(typeof p)),
    `no bind param may reach the driver as a Date object, got: ${JSON.stringify(
      params.map((p) => (p instanceof Date ? 'Date' : typeof p)),
    )}`,
  );
  // The cutoff travels as a recent-timestamp bind parameter, not literal SQL.
  assert.ok(
    params.some((p) => {
      const t = Date.parse(String(p));
      return Number.isFinite(t) && Math.abs(t - Date.now()) < 10 * 60_000;
    }),
    `staleCutoff must be passed as a recent-timestamp bind parameter, got: ${JSON.stringify(params)}`,
  );
});

test('createDefaultTaskRunnerDeps: production deps carry a log so silent poll failures surface', () => {
  // The post-#196 incident was silent because createDefaultTaskRunnerDeps() passed log through
  // as undefined — both the summary path and startTaskRunnerPolling's .catch were no-ops.
  const deps = createDefaultTaskRunnerDeps({});
  assert.ok(deps.log && typeof deps.log.info === 'function', 'default deps must default to a real logger');

  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    deps.log!.info('task-run poll failed', { error: 'boom' });
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /\[trace:task-run\].*task-run poll failed.*boom/);
});

// ─── S3 (#196 soft-pack): the heartbeat side keeps one slot of the budget ───
// Heartbeats never consult the task-runner slots and task wakes bypass agentLocks, so the
// OLD default (taskCap = RUN_TASK_CAP_PER_AGENT = 2 on budget 2) could stack 2 live task
// runs + 1 heartbeat = 3 concurrent runs on one agent. The fix reserves one budget slot:
// the default task cap is min(RUN_TASK_CAP_PER_AGENT, budget-1).

test('S3: defaultTaskCapPerAgent reserves one slot for the heartbeat side', () => {
  assert.equal(defaultTaskCapPerAgent(2), 1); // defaults: budget 2 → ONE task at a time
  assert.equal(defaultTaskCapPerAgent(3), 2); // budget 3 → the full ceiling of 2
  assert.equal(defaultTaskCapPerAgent(10), 2); // never above RUN_TASK_CAP_PER_AGENT
  assert.equal(defaultTaskCapPerAgent(1), 0); // all of one slot belongs to the heartbeat side
  assert.equal(defaultTaskCapPerAgent(0), 0); // the off switch stays off
  // freeTaskRunSlots defaults follow the same derivation (no explicit taskCap).
  assert.equal(freeTaskRunSlots({ total: 0, task: 0 }, 2), 1);
  assert.equal(freeTaskRunSlots({ total: 0, task: 0 }, 4), 2);
  assert.equal(freeTaskRunSlots({ total: 1, task: 0 }, 2), 1); // heartbeat busy → ONE task may fill the budget
  assert.equal(freeTaskRunSlots({ total: 2, task: 1 }, 2), 0); // budget filled → the rest waits
});

test('S3: defaults never stack 2 task runs + 1 heartbeat on a budget of 2', async () => {
  // Idle agent, three queued tasks: one poll tick may start at most budget-1 = 1 task run.
  const rows = [row({ taskId: 't1', position: 0 }), row({ taskId: 't2', position: 1 }), row({ taskId: 't3', position: 2 })];
  const idle = fakes({ rows, slots: { total: 0, task: 0 } });
  const s1 = await pollTaskRunner(idle.deps, {});
  assert.equal(s1.started.length, 1, 'one tick starts at most budget-1 task runs by default');
  await drain(s1);

  // One task run + one heartbeat now live (total 2 of 2): the next tick starts nothing —
  // this is exactly the 3-concurrent hole the reservation closes.
  const busy = fakes({ rows: [row({ taskId: 't2', position: 1 })], slots: { total: 2, task: 1 } });
  const s2 = await pollTaskRunner(busy.deps, {});
  assert.equal(s2.started.length, 0);
  assert.equal(s2.skippedFull, 1);
  assert.deepEqual(busy.claims, [], 'no claim → no attempt budget burned while the budget is full');
});

test('S3: an explicit taskCap still overrides the reservation', async () => {
  const rows = [row({ taskId: 't1', position: 0 }), row({ taskId: 't2', position: 1 }), row({ taskId: 't3', position: 2 })];
  const f = fakes({ rows, slots: { total: 0, task: 0 } });
  const s = await pollTaskRunner(f.deps, { maxConcurrentRuns: 4, taskCap: 2 });
  assert.equal(s.started.length, 2);
  await drain(s);
  assert.equal(f.settles.length, 2);
});

// ─── S7 (#196 soft-pack): mutants M6 and M10 ─────────────────────────────────

/** Drizzle-over-postgres-js fake: returns SELECT-ordered raw rows and rejects non-primitive params. */
function fakeRowDb(rows: unknown[][]) {
  const client = {
    options: { parsers: {}, serializers: {}, types: {} },
    PostgresError: class PostgresError extends Error {},
    END: {},
    listen: () => () => {},
    unsafe(query: string, params: unknown[]) {
      for (const p of params ?? []) {
        if (p !== null && !(typeof p === 'string' || typeof p === 'number' || typeof p === 'boolean')) {
          const err: Error & { code?: string } = new TypeError('non-primitive bind param reached the driver');
          err.code = 'ERR_INVALID_ARG_TYPE';
          throw err;
        }
      }
      const promise = Promise.resolve(rows) as Promise<unknown> & { values: () => Promise<unknown> };
      promise.values = () => Promise.resolve(rows);
      return promise;
    },
  };
  return drizzle(client as never, { schema: {} as never }) as unknown as ChatTaskDb;
}

test('M6: countActiveRuns counts TASK rows apart from total (kill the task-counter mutant)', async () => {
  // All-task rows: task must equal total (mutant: drop the invocationSource branch → task 0).
  const allTask = await countActiveRuns(fakeRowDb([['task'], ['task'], ['task']]), A);
  assert.deepEqual(allTask, { total: 3, task: 3 });
  // No task rows: task must be 0 while total counts the heartbeats (mutant: count everything
  // as task → a heartbeat-only agent would freeze its task queue behind a fake cap).
  const noTask = await countActiveRuns(fakeRowDb([['timer'], ['assignment'], ['approval']]), A);
  assert.deepEqual(noTask, { total: 3, task: 0 });
  // Mixed: only 'task' rows count toward the per-agent task cap.
  const mixed = await countActiveRuns(fakeRowDb([['task'], ['timer'], ['task'], ['timer']]), A);
  assert.deepEqual(mixed, { total: 4, task: 2 });
});

test('M10: a false claim result stops the task — no wake, no progress, no settle (kill the ignore-claim mutant)', async () => {
  const f = fakes({ rows: [row({ taskId: 't1', position: 0 }), row({ taskId: 't2', position: 1 })], slots: { total: 0, task: 0 } });
  const claimed: string[] = [];
  f.deps.claim = async (taskId) => {
    claimed.push(taskId);
    return taskId === 't2'; // t1 lost the race (paused / cancelled / re-prioritised mid-tick)
  };
  const s = await pollTaskRunner(f.deps, { maxConcurrentRuns: 4, taskCap: 2 });
  assert.deepEqual(claimed, ['t1', 't2'], 'every batch candidate is offered a claim');
  assert.deepEqual(s.started.map((x) => x.taskId), ['t2'], 'an unclaimed task never enters started');
  await drain(s);
  assert.deepEqual(f.jobs.map((j) => j.chatTaskId), ['t2'], 'no Run Task wake may fire for an unclaimed task');
  assert.deepEqual(f.settles, [{ taskId: 't2', status: 'done' }], 'only the claimed task settles');
  assert.deepEqual(f.progress, ['started:running', 'done:succeeded'], 'no progress events for the loser');
});
