/**
 * #199 ACCEPT softs S199a–S199d — TASK-RUNNER poll log level, defer-log rate limit,
 * per-agent tick isolation, and the REAL postgres-js Date-bind boundary.
 *
 * S199a: a poll failure logged at `info` was buried in scheduler noise (the post-#196
 *   incident was only found by reading every info line). startTaskRunnerPolling's catch now
 *   prefers log.error → log.warn → log.info, message content unchanged. These tests pin the
 *   LEVEL the line lands on (and the trace logger routes error→console.error, so level-based
 *   log tooling can grep it).
 *
 * S199b: `task-run slots full, deferring` fired once per 30s tick per busy agent. The first
 *   deferral still logs; repeats for the same agent inside the quiet window are suppressed,
 *   and a slot-freeing tick resets the agent so the NEXT deferral is loud again. Pin below
 *   drives repeated ticks through the real poller loop with a 5s interval + injected clock.
 *
 * S199c: one agent's countActiveRuns/claim throwing escaped pollTaskRunner and aborted the
 *   WHOLE tick (the poller catch swallowed it, every other agent starved until the next
 *   interval). Per-agent try/catch now logs and continues. Pins: agent A throws on
 *   countActiveRuns and on claim — B claims and starts in both cases, summary reports
 *   skippedErrored, and NO 'task-run poll failed' line appears (agent errors never reach
 *   the tick-level catch).
 *
 * S199d: the existing fake-client pin (task-runner.test.ts) copies the driver's type gate,
 *   but a probe against the REAL postgres-js 3.4.9 shows the copy is STRICTER than the
 *   driver: `client.unsafe(sql, [Date])` on an unprepared connection is actually ACCEPTED
 *   (types.js sniffs Date at a string position and serialises via toISOString). The real
 *   production crash lives one level deeper: drizzle's raw sql`${col} >= ${Date}` sends the
 *   param untyped, the driver takes the extended-query (prepared) path, and Node's string
 *   argument check raises ERR_INVALID_ARG_TYPE. This file therefore runs countActiveRuns
 *   against a REAL Postgres over postgres-js: the gte form must be GREEN end-to-end (and
 *   reach the driver with a pre-serialised ISO string), while the raw-Date sql form must
 *   stay RED at that same driver boundary. Gated on TOURBILLON_TEST_DATABASE_URL — CI
 *   without a live db skips, the CI-with-postgres run executes it for real.
 *
 * #233 ACCEPT softs on this file (S233-S1–S3, S6):
 *   S233-S1: migrateUp used to replay EVERY migration with no hash check — a second run
 *     against the same database died with `relation "companies" already exists`.
 *     applyMigrations() now skips hashes already recorded in drizzle.__drizzle_migrations;
 *     idempotency is pinned on PGlite (always on) and on the live db.
 *   S233-S2: seed() wipes heartbeat_runs/agents/companies — assertTestDatabaseUrl() now
 *     refuses unless the target db NAME carries a `test` token, checked BEFORE a single
 *     statement runs. A mis-pointed TOURBILLON_TEST_DATABASE_URL can no longer nuke a real
 *     workspace.
 *   S233-S3: no CI workflow sets TOURBILLON_TEST_DATABASE_URL, so the live block skips by
 *     default. Exact local run (disposable container — the seed guard REQUIRES a test-named
 *     db):
 *       docker run -d --rm --name tourbillon-test-pg -e POSTGRES_PASSWORD=*** \
 *         -p 5433:5432 postgres:16
 *       docker exec tourbillon-test-pg psql -U postgres -c 'create database tourbillon_test'
 *       TOURBILLON_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/tourbillon_test \
 *         pnpm --filter @tourbillon/scheduler test
 *     Setting TOURBILLON_TEST_REQUIRE_LIVE=1 WITHOUT the URL turns the skip into a FAILURE,
 *     so a job that means to run live can prove it actually did.
 *   S233-S6: the real-loop pins no longer sleep (50–11_500 ms): startTaskRunnerPolling gained
 *     an intervalMs test seam (bypasses the 5s floor) and poller.whenTicks(n) — pins await
 *     exact tick counts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { and, eq, or, isNull, gte, sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { heartbeatRuns } from '@tourbillon/db';
import * as schema from '@tourbillon/db/schema';
import type { ChatTaskDb, RunnableChatTaskRow } from '@tourbillon/db';
import {
  countActiveRuns,
  createDefaultTaskRunnerDeps,
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

/** Logger fake that records the LEVEL each line was logged at (S199a pins read this). */
function recordingLog() {
  const lines: LogCall[] = [];
  const push = (level: LogCall['level']) => (msg: string, data?: Record<string, unknown>) =>
    lines.push({ level, msg, data });
  const log = { info: push('info'), warn: push('warn'), error: push('error') };
  const forLevel = (level: LogCall['level']): TaskRunnerDeps['log'] => ({
    info: level === 'info' ? push('info') : undefined,
    warn: level === 'warn' ? push('warn') : undefined,
    error: level === 'error' ? push('error') : undefined,
  } as unknown as TaskRunnerDeps['log']);
  return { lines, log, forLevel };
}

function fakes(opts: {
  rows: RunnableChatTaskRow[];
  slots?: Record<string, { total: number; task: number }>;
  throwOnCount?: (agentId: string) => Error | undefined;
  throwOnClaim?: (taskId: string) => Error | undefined;
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
      const err = opts.throwOnClaim?.(taskId);
      if (err) throw err;
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

const drain = (s: Awaited<ReturnType<typeof pollTaskRunner>>) =>
  Promise.all(s.started.map((x) => x.done));

// ─── S199a — poll failure log LEVEL ─────────────────────────────────────────

test('S199a: a poll failure logs at ERROR level with the message content unchanged', async () => {
  const { lines, forLevel } = recordingLog();
  const base = fakes({ rows: [] });
  const deps: TaskRunnerDeps = {
    ...base.deps,
    listRunnable: async () => {
      throw new Error('db exploded');
    },
    log: forLevel('error'),
  };
  const poller = startTaskRunnerPolling(deps, { intervalMs: 10, maxConcurrentRuns: 2 });
  await poller.whenTicks(); // S233-S6: await the first COMPLETED tick — no sleep guessing
  poller.stop();

  const failed = lines.filter((l) => l.msg === 'task-run poll failed');
  assert.equal(failed.length, 1, 'exactly one failure line for one failing tick');
  assert.equal(failed[0]!.level, 'error', 'poll failure must be greppable at error level, not info');
  assert.deepEqual(failed[0]!.data, { error: 'db exploded' }, 'message payload unchanged');
});

test('S199a: with no error method the failure falls back to warn, then to info', async () => {
  for (const level of ['warn', 'info'] as const) {
    const { lines, forLevel } = recordingLog();
    const base = fakes({ rows: [] });
    const deps: TaskRunnerDeps = {
      ...base.deps,
      listRunnable: async () => {
        throw new Error('boom');
      },
      log: forLevel(level),
    };
    const poller = startTaskRunnerPolling(deps, { intervalMs: 10 });
    await poller.whenTicks(); // S233-S6: exactly one completed tick, no sleep guessing
    poller.stop();
    const failed = lines.filter((l) => l.msg === 'task-run poll failed');
    assert.equal(failed.length, 1, `${level}: one failure line`);
    assert.equal(failed[0]!.level, level, `failure falls back to the best available level (${level})`);
  }
});

test('S199a: the DEFAULT production logger routes the failure line through console.error', () => {
  // createTraceLogger exposes warn/error (console.warn/console.error), so the production
  // default of createDefaultTaskRunnerDeps takes the error branch — level-greppable output.
  const deps = createDefaultTaskRunnerDeps({});
  assert.ok(deps.log && typeof deps.log.info === 'function');
  assert.equal(typeof deps.log!.warn, 'function', 'default logger must expose warn');
  assert.equal(typeof deps.log!.error, 'function', 'default logger must expose error');

  const out: string[] = [];
  const err: string[] = [];
  const original = { log: console.log, error: console.error };
  console.log = (...a: unknown[]) => out.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => err.push(a.map(String).join(' '));
  try {
    deps.log!.error!('task-run poll failed', { error: 'boom' });
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
  assert.deepEqual(out, [], 'an error-level line must NOT land on the info stream');
  assert.equal(err.length, 1);
  assert.match(err[0]!, /\[trace:task-run\].*task-run poll failed.*boom/);
});

// ─── S199b — "slots full, deferring" rate limit ─────────────────────────────

test('S199b: repeated deferrals for one agent log ONCE — first tick loud, repeats quiet inside the window', async () => {
  const { lines, log } = recordingLog();
  const f = fakes({ rows: [row({ taskId: 't1', agentId: 'a-busy' })], slots: { 'a-busy': { total: 2, task: 1 } }, log });
  const mem = new Map<string, number>();
  let clock = 1_000_000;
  const opts = { maxConcurrentRuns: 2, taskCap: 1, deferLogMemory: mem, now: () => clock };

  const s1 = await pollTaskRunner(f.deps, opts);
  const s2 = await pollTaskRunner(f.deps, { ...opts, deferLogMemory: mem });
  clock += 60_000; // 1 min later — still inside the 10-min window
  const s3 = await pollTaskRunner(f.deps, opts);

  const deferLines = lines.filter((l) => l.msg === 'task-run slots full, deferring');
  assert.equal(deferLines.length, 1, 'three full ticks → exactly one defer line');
  assert.deepEqual(deferLines[0]!.data, { agentId: 'a-busy', pending: 1, slot: { total: 2, task: 1 } },
    'the kept line keeps its full payload');
  assert.equal(mem.get('a-busy'), 1_000_000, 'memory stamps the first log time');
  assert.deepEqual([s1.skippedFull, s2.skippedFull, s3.skippedFull], [1, 1, 1],
    'rate-limiting the LOG must not change the skippedFull accounting');
  assert.deepEqual(f.claims, [], 'deferred tasks are never claimed');
});

test('S199b: past the quiet window the agent goes loud again', async () => {
  const { lines, log } = recordingLog();
  const f = fakes({ rows: [row({ taskId: 't1', agentId: 'a-busy' })], slots: { 'a-busy': { total: 2, task: 1 } }, log });
  const mem = new Map<string, number>();
  let clock = 0;
  const opts = () => ({ maxConcurrentRuns: 2, taskCap: 1, deferLogMemory: mem, now: () => clock });

  await pollTaskRunner(f.deps, opts()); // logs at t=0
  clock += 9 * 60_000;
  await pollTaskRunner(f.deps, opts()); // inside window — quiet
  clock += 2 * 60_000; // total 11 min ≥ 10-min window
  await pollTaskRunner(f.deps, opts()); // window expired — loud again

  assert.equal(lines.filter((l) => l.msg === 'task-run slots full, deferring').length, 2);
});

test('S199b: a slot-freeing tick resets the agent — the NEXT deferral is loud again', async () => {
  const { lines, log } = recordingLog();
  let slots: Record<string, { total: number; task: number }> = { 'a1': { total: 2, task: 1 } };
  const f = fakes({ rows: [row({ taskId: 't1', agentId: 'a1' })], log });
  f.deps.countActiveRuns = async (agentId) => slots[agentId] ?? { total: 0, task: 0 };
  const mem = new Map<string, number>();
  let clock = 0;
  const opts = () => ({ maxConcurrentRuns: 2, taskCap: 1, deferLogMemory: mem, now: () => clock });

  await pollTaskRunner(f.deps, opts());
  assert.equal(mem.size, 1, 'deferral stamped');
  slots = { 'a1': { total: 0, task: 0 } };
  const free = await pollTaskRunner(f.deps, opts());
  await drain(free);
  assert.equal(mem.size, 0, 'a free-slot tick drops the agent from the rate-limit memory');
  slots = { 'a1': { total: 2, task: 1 } };
  await pollTaskRunner(f.deps, opts());
  assert.equal(
    lines.filter((l) => l.msg === 'task-run slots full, deferring').length,
    2,
    'defer → run → defer again is loud both times, even inside the window',
  );
});

test('S199b: the rate limit is PER AGENT — two busy agents each get their first line', async () => {
  const { lines, log } = recordingLog();
  const rows = [
    row({ taskId: 't1', agentId: 'a1' }),
    row({ taskId: 't2', agentId: 'a2' }),
  ];
  const slots = { a1: { total: 2, task: 1 }, a2: { total: 2, task: 1 } };
  const f = fakes({ rows, slots, log });
  const mem = new Map<string, number>();
  const opts = () => ({ maxConcurrentRuns: 2, taskCap: 1, deferLogMemory: mem, now: () => 0 });

  const s = await pollTaskRunner(f.deps, opts());
  assert.equal(s.skippedFull, 2);
  assert.deepEqual(
    lines.filter((l) => l.msg === 'task-run slots full, deferring').map((l) => l.data?.agentId),
    ['a1', 'a2'],
    'one suppressed agent must not silence another agent first log',
  );
});

test('S199b: through the REAL poller loop, three ticks one busy agent = one defer line', async () => {
  const { lines, log } = recordingLog();
  const f = fakes({ rows: [row({ taskId: 't1', agentId: 'a-busy' })], slots: { 'a-busy': { total: 2, task: 1 } }, log });
  // S233-S6: intervalMs seam + whenTicks(3) replaces the 11.5s sleep — exact tick counts,
  // sub-100ms runtime, and the every-5s floor is only a PRODUCTION default (opt-in override).
  const poller = startTaskRunnerPolling(f.deps, { intervalMs: 10, maxConcurrentRuns: 2, taskCap: 1 });
  await poller.whenTicks(3); // three COMPLETED ticks (t≈0 + two 10ms intervals)
  poller.stop();

  const deferLines = lines.filter((l) => l.msg === 'task-run slots full, deferring');
  assert.equal(deferLines.length, 1, 'three every-5s ticks must produce ONE line, not three');
  assert.equal(lines.filter((l) => l.msg === 'task-run poll').length, 3, 'the tick summary still logs all three ticks');
  assert.deepEqual(f.claims, [], 'nothing claimed while the budget is full');
});

// ─── S199c — per-agent try/catch isolation ──────────────────────────────────

test('S199c: one agent countActiveRuns throw cannot starve the rest of the queue', async () => {
  const { lines, log } = recordingLog();
  const rows = [
    row({ taskId: 't-bad', agentId: 'a-bad' }),
    row({ taskId: 't-good', agentId: 'a-good' }),
  ];
  const f = fakes({
    rows,
    slots: { 'a-good': { total: 0, task: 0 } },
    throwOnCount: (agentId) => (agentId === 'a-bad' ? new Error('driver exploded') : undefined),
    log,
  });
  const s = await pollTaskRunner(f.deps, { maxConcurrentRuns: 2, taskCap: 1 });

  assert.equal(s.skippedErrored, 1, 'the throwing agent is counted, not fatal');
  assert.deepEqual(s.started.map((x) => x.taskId), ['t-good'], 'the healthy agent still claims and starts');
  assert.deepEqual(f.claims, ['t-good'], 'the broken agent is never claimed');
  await drain(s);
  assert.deepEqual(f.settles, [{ taskId: 't-good', status: 'done' }]);

  const agentErr = lines.filter((l) => l.msg === 'task-run agent poll failed');
  assert.equal(agentErr.length, 1, 'the failure is logged');
  assert.equal(agentErr[0]!.level, 'error');
  assert.deepEqual(agentErr[0]!.data, { agentId: 'a-bad', error: 'driver exploded' });
  assert.deepEqual(lines.filter((l) => l.msg === 'task-run poll failed'), [],
    'an agent-scoped error must NOT abort the tick (no tick-level failure line)');
});

test('S199c: a claim throw for one agent still lets another agent claim in the same tick', async () => {
  const { log } = recordingLog();
  const rows = [
    row({ taskId: 't-bad', agentId: 'a-bad' }),
    row({ taskId: 't-good', agentId: 'a-good' }),
  ];
  const f = fakes({
    rows,
    slots: { 'a-bad': { total: 0, task: 0 }, 'a-good': { total: 0, task: 0 } },
    throwOnClaim: (taskId) => (taskId === 't-bad' ? new Error('claim blew up') : undefined),
    log,
  });
  const s = await pollTaskRunner(f.deps, { maxConcurrentRuns: 2, taskCap: 1 });

  assert.equal(s.skippedErrored, 1);
  assert.deepEqual(s.started.map((x) => x.taskId), ['t-good']);
  await drain(s);
  assert.deepEqual(f.jobs.map((j) => j.chatTaskId), ['t-good'], 'only the healthy agent fires a Run Task wake');
});

test('S199c: through the REAL poller loop, a throwing agent does not stop the healthy agent wake', async () => {
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
  await poller.whenTicks(); // S233-S6: one completed tick replaces the 60ms sleep
  poller.stop();

  assert.deepEqual(f.jobs.map((j) => j.chatTaskId), ['t-good'], 'healthy agent started despite the bad one');
  assert.equal(lines.filter((l) => l.msg === 'task-run agent poll failed').length, 1);
  assert.deepEqual(lines.filter((l) => l.msg === 'task-run poll failed'), [],
    'agent isolation means the tick-level catch never fires for agent-scoped errors');
});

// ─── S199d — REAL postgres-js Date-bind boundary ────────────────────────────
// Gated integration: live Postgres over postgres-js (prepare:false, exactly like
// packages/db/src/client.ts). Without TOURBILLON_TEST_DATABASE_URL the block skips; a CI
// with a postgres service runs it for real. The prod-shaped client is non-negotiable here:
// the whole point is the driver boundary, so PGlite would test the wrong driver.

const LIVE_URL = process.env.TOURBILLON_TEST_DATABASE_URL;
// S233-S3: opt-in clarity. TOURBILLON_TEST_REQUIRE_LIVE=1 without the URL turns the default
// skip into a hard FAILURE (requireLive() below), so a CI/local job that means to run the
// live block can PROVE it ran instead of silently skipping it. Exact command in the header.
const REQUIRE_LIVE = /^(1|true|yes)$/i.test(process.env.TOURBILLON_TEST_REQUIRE_LIVE ?? '');
const LIVE_SKIP =
  'set TOURBILLON_TEST_DATABASE_URL to a live, test-NAMED postgres db to run the real postgres-js ' +
  'boundary tests (exact docker + run command: see the S233-S3 header block in this file; ' +
  'TOURBILLON_TEST_REQUIRE_LIVE=1 turns this skip into a failure)';
const liveSkipReason = LIVE_URL || REQUIRE_LIVE ? false : LIVE_SKIP;

/**
 * S233-S3: fail (never skip) when the operator demanded live pins but gave no db URL.
 * S233-S2: also the single entry guard for EVERY live pin — a mis-pointed URL (even a
 * non-test-named db the additive migrator would happily touch) refuses before any pin runs.
 */
function requireLive(): void {
  if (!LIVE_URL) {
    if (REQUIRE_LIVE) {
      assert.fail(`TOURBILLON_TEST_REQUIRE_LIVE=1 is set but TOURBILLON_TEST_DATABASE_URL is missing — ${LIVE_SKIP}`);
    }
    return;
  }
  assertTestDatabaseUrl(LIVE_URL);
}

const dbRequire = createRequire(path.join(__dirname, '../../db/package.json'));

interface UnsafeSpy {
  calls: Array<{ sql: string; params: unknown[] }>;
}

/** The minimal tagged-template surface applyMigrations needs (postgres-js pool tag shape). */
interface MigrationSqlTag {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<unknown>;
  unsafe(sql: string, params?: unknown[], options?: unknown): Promise<unknown>;
}

function liveClient(): { sqlTag: MigrationSqlTag; db: ChatTaskDb; spy: UnsafeSpy; close: () => Promise<void> } {
  const postgres = dbRequire('postgres');
  const { drizzle: drizzlePg } = dbRequire('drizzle-orm/postgres-js');
  const pool = postgres(LIVE_URL!, { prepare: false, max: 2, idle_timeout: 10, max_lifetime: 60 });
  // The drizzle postgres-js driver routes every query through client.unsafe() when
  // prepare:false (same call the fake pin replicates). Spy it to watch the REAL params.
  const spy: UnsafeSpy = { calls: [] };
  const originalUnsafe = pool.unsafe.bind(pool);
  (pool as { unsafe: (q: string, p?: unknown[], o?: unknown) => unknown }).unsafe = (
    query: string,
    params: unknown[] = [],
    options?: unknown,
  ) => {
    spy.calls.push({ sql: query, params });
    return originalUnsafe(query, params, options);
  };
  return {
    sqlTag: pool,
    db: drizzlePg(pool, { schema }) as unknown as ChatTaskDb,
    spy,
    close: () => pool.end(),
  };
}

/**
 * S233-S1: apply every journal migration NOT already recorded in drizzle.__drizzle_migrations.
 * The historic version replayed ALL migration SQL on every call with no hash check, so a
 * second run against the same database died with `relation "companies" already exists` (e.g.
 * a leftover TOURBILLON_TEST_DATABASE_URL db from a previous run). The applied-hash skip makes
 * a rerun a GREEN no-op; the ledger itself is created with if-not-exists DDL above.
 *
 * Separated from the memo wrapper (migrateUp) so the idempotency pins can call the REAL apply
 * path twice — the memo would otherwise hide a second invocation entirely.
 */
async function applyMigrations(sqlTag: MigrationSqlTag): Promise<void> {
  const migrationsFolder = path.join(__dirname, '../../db/src/migrations');
  const journal = (
    JSON.parse(
      readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { tag: string; when: number }[] }
  ).entries;
  const whenLatest = journal[journal.length - 1]!.when;
  await sqlTag`create schema if not exists drizzle`;
  await sqlTag`create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text, created_at bigint)`;
  const appliedRows = (await sqlTag`select hash from drizzle.__drizzle_migrations`) as Array<{
    hash: string;
  }>;
  const applied = new Set(appliedRows.map((r) => r.hash));
  for (const m of readMigrationFiles({ migrationsFolder })) {
    if (m.folderMillis > whenLatest) break;
    if (applied.has(m.hash)) continue; // S233-S1: already applied — a rerun must be a no-op
    for (const chunk of m.sql) {
      if (chunk.trim()) await sqlTag.unsafe(chunk, [], { prepare: false });
    }
    await sqlTag`insert into drizzle.__drizzle_migrations (hash, created_at) values (${m.hash}, ${m.folderMillis})`;
    applied.add(m.hash);
  }
}

let migratedOnce: Promise<void> | undefined;

async function migrateUp(sqlTag: MigrationSqlTag): Promise<void> {
  migratedOnce ??= applyMigrations(sqlTag);
  await migratedOnce;
}

/**
 * S233-S2: seed() deletes EVERY row of heartbeat_runs / agents / companies. Refuse unless the
 * target db NAME carries a `test` token (tourbillon_test, tb-test, test …) — a mis-pointed
 * TOURBILLON_TEST_DATABASE_URL must never wipe a real workspace. Pure function so the refusal
 * is pinned without any live db.
 */
function assertTestDatabaseUrl(rawUrl: string, label = 'TOURBILLON_TEST_DATABASE_URL'): string {
  let name: string;
  try {
    name = new URL(rawUrl).pathname.replace(/^\//, '');
  } catch {
    throw new Error(`${label}="${rawUrl}" is not a parseable postgres URL — refusing the destructive seed`);
  }
  if (!/(^|[-_.])test([-_.]|$)/i.test(name)) {
    throw new Error(
      `${label} points at database "${name}" — not a test-named database. seed() deletes every row in ` +
        'companies / agents / heartbeat_runs; point it at a disposable db whose name contains a "test" ' +
        'token (e.g. tourbillon_test) and rerun.',
    );
  }
  return name;
}

/** Deterministic seed: 2 live rows for AGENT (1 task + 1 null-lastSeen timer), noise for others. */
async function seed(
  client: { sqlTag: MigrationSqlTag },
  targetUrl: string = LIVE_URL ?? '',
): Promise<void> {
  // S233-S2: guard runs BEFORE a single statement touches the db.
  assertTestDatabaseUrl(targetUrl);
  const { sqlTag } = client;
  await sqlTag`delete from heartbeat_runs`;
  await sqlTag`delete from agents`;
  await sqlTag`delete from companies`;
  await sqlTag`insert into companies (id, name, slug, issue_prefix) values
    ('c1', 'Bug Hunt', 'bug-hunt', 'BH'), ('c2', 'Other Co', 'other', 'OC')`;
  await sqlTag`insert into agents (id, company_id, name, role, title, url_key) values
    ('agent-live', 'c1', 'Live Agent', 'engineer', 'Engineer', 'agent-live'),
    ('agent-noise', 'c2', 'Noise Agent', 'engineer', 'Engineer', 'agent-noise')`;
  await sqlTag`insert into heartbeat_runs (id, company_id, agent_id, invocation_source, status, last_seen_at) values
    ('r-live-task', 'c1', 'agent-live', 'task',     'running', now()),
    ('r-live-null', 'c1', 'agent-live', 'timer',    'queued',  null),
    ('r-live-stale','c1', 'agent-live', 'assignment','running', now() - interval '1 day'),
    ('r-live-done', 'c1', 'agent-live', 'task',     'succeeded', now()),
    ('r-noise',     'c2', 'agent-noise','task',     'queued',  now())`;
}

/** The exact historical bug: raw sql interpolation of the Date cutoff (pre-hotfix countActiveRuns). */
function buggyRawDateWhere(cutoff: Date) {
  return and(
    eq(heartbeatRuns.agentId, 'agent-live'),
    sql`${heartbeatRuns.status} in ('queued', 'running')`,
    // The regression proper: Date straight into the sql template, bypassing the column
    // serializer — the param reaches the driver UNTYPED.
    or(isNull(heartbeatRuns.lastSeenAt), sql`${heartbeatRuns.lastSeenAt} >= ${cutoff}`),
  );
}

test('S199d (live): countActiveRuns is GREEN end-to-end on real postgres-js — gte binds a pre-serialised ISO string', { skip: liveSkipReason }, async () => {
  requireLive(); // S233-S3: demanded live but no URL → hard failure, never a silent skip
  const client = liveClient();
  try {
    await migrateUp(client.sqlTag);
    await seed(client);

    const slot = await countActiveRuns(client.db, 'agent-live');
    assert.deepEqual(slot, { total: 2, task: 1 },
      'live rows counted (task + fresh-null), stale and terminal rows and other agents excluded — against the REAL driver');

    const countCall = client.spy.calls.find(
      (c) => /^\s*select\b/i.test(c.sql) && c.sql.includes('"heartbeat_runs"'),
    );
    assert.ok(countCall, 'the spy must have seen the real driver call');
    assert.match(
      countCall!.sql,
      /"heartbeat_runs"\."last_seen_at" is null or "heartbeat_runs"\."last_seen_at" >= \$\d+/,
      'gte stays the pinned shape at the real boundary',
    );
    assert.ok(
      !countCall!.params.some((p) => p instanceof Date),
      `no bind param may reach the REAL driver as a Date, got: ${countCall!.params.map((p) => (p instanceof Date ? 'Date' : typeof p)).join(',')}`,
    );
    assert.ok(
      countCall!.params.some((p) => typeof p === 'string' && Number.isFinite(Date.parse(p))),
      'the cutoff travels pre-serialised as an ISO string (what gte + the timestamp serializer produce)',
    );
  } finally {
    await client.close();
  }
});

test('S199d (live): the raw-Date sql form stays RED at the same driver boundary — proving why gte is load-bearing', { skip: liveSkipReason }, async () => {
  requireLive(); // S233-S3
  const client = liveClient();
  try {
    await migrateUp(client.sqlTag);
    await seed(client);

    // Same table, same connection, same driver — only the WHERE differs. This is the form
    // that crashed every tick post-#196: drizzle hands the untyped Date param to the driver,
    // which takes the extended-query path and Node raises ERR_INVALID_ARG_TYPE.
    await assert.rejects(
      () =>
        client.db
          .select({ invocationSource: heartbeatRuns.invocationSource })
          .from(heartbeatRuns)
          .where(buggyRawDateWhere(new Date(Date.now() - 600_000))),
      (err: unknown) => {
        // Drizzle wraps the driver failure: Error("Failed query: …") whose cause chain holds
        // the Node TypeError ERR_INVALID_ARG_TYPE ("string" argument … Received an instance
        // of Date) — exactly the post-#196 production crash. Walk the chain, don't just
        // string-match the wrapper.
        const seen: string[] = [];
        let e: unknown = err;
        for (let depth = 0; e && depth < 5; depth++) {
          const asErr = e as { code?: string; name?: string; message?: string; cause?: unknown };
          if (asErr.code === 'ERR_INVALID_ARG_TYPE') return true;
          seen.push(`${asErr.name ?? ''}:${asErr.message ?? ''}`);
          e = asErr.cause;
        }
        assert.fail(
          `the REAL driver boundary must reject the raw-Date bind with ERR_INVALID_ARG_TYPE in the cause chain, got: ${seen.join(' <- ')}`,
        );
      },
      'raw-Date sql form must stay RED against the real postgres-js driver',
    );
  } finally {
    await client.close();
  }
});

// ─── S233 — #233 ACCEPT softs on this file's live helpers ────────────────────

interface PGliteLike {
  exec(sql: string): Promise<unknown>;
  query(sql: string, params?: unknown[], config?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * PGlite adapter for the applyMigrations tagged-template surface. The S233-S1 idempotency
 * question is about the LEDGER SKIP, not the driver, so PGlite is the right tool here (the
 * S199d pins deliberately stay on real postgres-js). Same dbRequire pattern as
 * task-runner-208-softs.test.ts — PGlite is a @tourbillon/db devDependency, not a scheduler one.
 */
function pgliteMigrationTag(client: PGliteLike): MigrationSqlTag {
  const tag = ((strings: TemplateStringsArray, ...params: unknown[]) =>
    client
      .query(strings.reduce((acc, s, i) => (i === 0 ? s : `${acc}$${i}${s}`), ''), params)
      .then((r) => (r as { rows?: unknown[] })?.rows ?? [])) as MigrationSqlTag;
  tag.unsafe = (sql: string) => client.exec(sql);
  return tag;
}

test('S233-S1: applyMigrations is idempotent — a second pass on the same database is a GREEN no-op (PGlite, always on)', async () => {
  const { PGlite } = dbRequire('@electric-sql/pglite') as { PGlite: new () => PGliteLike };
  const pglite = new PGlite();
  const tag = pgliteMigrationTag(pglite);
  try {
    await applyMigrations(tag);
    const first = (await tag`select hash from drizzle.__drizzle_migrations`) as Array<{ hash: string }>;
    assert.ok(first.length > 0, 'the first pass must record the migration ledger');

    // Historic crash point: the second run replayed ALL migration SQL with no hash check and
    // died on `relation "companies" already exists`. With the applied-hash skip it is a no-op.
    await applyMigrations(tag);
    const second = (await tag`select hash from drizzle.__drizzle_migrations`) as Array<{ hash: string }>;
    assert.deepEqual(
      second.map((r) => r.hash),
      first.map((r) => r.hash),
      'the second pass must skip every recorded hash and insert nothing new',
    );
  } finally {
    await pglite.close();
  }
});

test('S233-S1 (live): two applyMigrations passes on the same live db are GREEN — rerun skips recorded hashes', { skip: liveSkipReason }, async () => {
  requireLive();
  const client = liveClient();
  try {
    await applyMigrations(client.sqlTag);
    await applyMigrations(client.sqlTag); // pre-fix: threw `relation "companies" already exists`
    const ledger = (await client.sqlTag`select hash from drizzle.__drizzle_migrations`) as Array<{
      hash: string;
    }>;
    assert.ok(ledger.length > 0, 'the live ledger is populated after the rerun');
  } finally {
    await client.close();
  }
});

test('S233-S2: the seed guard refuses non-test db names and accepts test-named ones', () => {
  for (const bad of [
    'postgres://u:p@h:5432/tourbillon',
    'postgresql://u:p@h:5432/postgres',
    'postgres://u:p@h:5432/production',
    'postgres://u:p@h:5432/protest', // substring trap — 'test' inside 'protest' is not a token
    'postgres://u:p@h:5432/tourbillon.testing', // substring trap — trailing 'ing' breaks the token
    'not a url',
  ]) {
    assert.throws(
      () => assertTestDatabaseUrl(bad),
      /not a test-named database|not a parseable/,
      `must refuse ${bad}`,
    );
  }
  for (const good of [
    'postgres://u:p@h:5432/tourbillon_test',
    'postgresql://u:p@h:5432/tb-test',
    'postgres://u:p@h:5432/test',
    'postgres://u:p@h/test.tourbillon',
  ]) {
    assert.doesNotThrow(() => assertTestDatabaseUrl(good), `must accept ${good}`);
  }
});

test('S233-S2: seed() refuses a mis-pointed URL BEFORE any statement reaches the db', async () => {
  let touched = 0;
  const explodingTag = (() => {
    touched += 1;
    return Promise.reject(new Error('the guard must have fired before this ran'));
  }) as unknown as MigrationSqlTag;
  explodingTag.unsafe = () => {
    touched += 1;
    return Promise.reject(new Error('the guard must have fired before this ran'));
  };

  await assert.rejects(
    () => seed({ sqlTag: explodingTag }, 'postgres://u:p@127.0.0.1:5432/tourbillon'),
    /not a test-named database/,
  );
  assert.equal(touched, 0, 'the wipe guard fires BEFORE the first delete reaches the db');
});
