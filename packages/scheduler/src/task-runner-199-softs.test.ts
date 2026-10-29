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
  const poller = startTaskRunnerPolling(deps, { intervalSec: 5, maxConcurrentRuns: 2 });
  await new Promise((r) => setTimeout(r, 50));
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
    const poller = startTaskRunnerPolling(deps, { intervalSec: 5 });
    await new Promise((r) => setTimeout(r, 50));
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
  const poller = startTaskRunnerPolling(f.deps, { intervalSec: 5, maxConcurrentRuns: 2, taskCap: 1 });
  await new Promise((r) => setTimeout(r, 11_500)); // ticks at t≈0, 5, 10s
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
  const poller = startTaskRunnerPolling(f.deps, { intervalSec: 5, maxConcurrentRuns: 2, taskCap: 1 });
  await new Promise((r) => setTimeout(r, 60));
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
const liveSkipReason = LIVE_URL
  ? false
  : 'set TOURBILLON_TEST_DATABASE_URL to run the real postgres-js boundary tests';

const dbRequire = createRequire(path.join(__dirname, '../../db/package.json'));

interface UnsafeSpy {
  calls: Array<{ sql: string; params: unknown[] }>;
}

function liveClient(): { sqlTag: any; db: ChatTaskDb; spy: UnsafeSpy; close: () => Promise<void> } {
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

let migratedOnce: Promise<void> | undefined;

async function migrateUp(sqlTag: any): Promise<void> {
  if (!migratedOnce) {
    migratedOnce = (async () => {
      const migrationsFolder = path.join(__dirname, '../../db/src/migrations');
      const journal = (
        JSON.parse(
          readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
        ) as { entries: { tag: string; when: number }[] }
      ).entries;
      const whenLatest = journal[journal.length - 1]!.when;
      await sqlTag`create schema if not exists drizzle`;
      await sqlTag`create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text, created_at bigint)`;
      for (const m of readMigrationFiles({ migrationsFolder })) {
        if (m.folderMillis > whenLatest) break;
        for (const chunk of m.sql) {
          if (chunk.trim()) await sqlTag.unsafe(chunk, [], { prepare: false });
        }
        await sqlTag`insert into drizzle.__drizzle_migrations (hash, created_at) values (${m.hash}, ${m.folderMillis})`;
      }
    })();
  }
  await migratedOnce;
}

/** Deterministic seed: 2 live rows for AGENT (1 task + 1 null-lastSeen timer), noise for others. */
async function seed(client: ReturnType<typeof liveClient>): Promise<void> {
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
