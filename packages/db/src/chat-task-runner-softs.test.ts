/**
 * #205 ACCEPT softs — runtime guards for the TASK-RUNNER query layer, against PGlite with the
 * repo's own migrations applied (same harness shape as chat-task-queries.test.ts, kept in its
 * OWN file so the #208 soft-pack appended to that file stays conflict-free).
 *
 * S1 (runtime reach of the per-company settings): removing `companySettings` from
 *   `runnableProjection` was only caught by scheduler `tsc` — every runtime test stayed green
 *   and the poller silently resolved every company to the DEFAULT settings. These tests read the
 *   real rows back: each runnable row must carry ITS OWN company's settings jsonb.
 * S2 (raw Date in the stale-reconcile sql template): PGlite accepts a Date bind param, so
 *   #202's ISO pre-serialisation was protected only by its comment — prod postgres-js
 *   (prepare:false) throws ERR_INVALID_ARG_TYPE on every reconcile. The spy below asserts at
 *   the driver boundary: no Date instance may reach `client.query` params, and the cutoff must
 *   arrive as its ISO string. Reverting to `${opts.staleCutoff}` in the template goes RED here.
 * S7 (fair-share under-fill): the S8 per-agent fair share wasted global slots when an agent
 *   had fewer rows than its share (A: 30, B: 1, limit 25 → 14). Backfill now tops up from the
 *   agents that filled their share; these tests pin the fill, the per-agent ceiling, and the
 *   no-re-query-of-exhausted-agents bound.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import * as schema from './schema/index';
import {
  addChatTask,
  listRunnableChatTasks,
  listStaleChatTaskRuns,
} from './chat-task-queries';

const MIGRATIONS = path.join(__dirname, 'migrations');
const JOURNAL = (
  JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string; when: number }[];
  }
).entries;
const WHEN_LATEST = JOURNAL[JOURNAL.length - 1]!.when;

/** Apply every migration in the journal (same rule as drizzle's migrator). */
async function migrateUp(client: PGlite): Promise<void> {
  await client.exec(`
    create schema if not exists drizzle;
    create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
  `);
  for (const m of readMigrationFiles({ migrationsFolder: MIGRATIONS })) {
    if (m.folderMillis > WHEN_LATEST) break;
    for (const chunk of m.sql) {
      if (chunk.trim()) await client.exec(chunk);
    }
    await client.query('insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)', [
      m.hash,
      m.folderMillis,
    ]);
  }
}

/** Fresh in-memory db, migrations applied, two companies / three agents seeded. */
async function freshDb() {
  const client = new PGlite();
  await migrateUp(client);
  const db = drizzle(client, { schema });
  await client.exec(`
    insert into companies (id, name, slug, issue_prefix) values ('c1', 'Bug Hunt', 'bug-hunt', 'BH'), ('c2', 'Other Co', 'other', 'OC');
    insert into agents (id, company_id, name, role, title, url_key) values
      ('a1', 'c1', 'Assistant', 'cto', 'The Assistant', 'assistant'),
      ('a2', 'c1', 'Other Agent', 'engineer', 'Engineer', 'other-agent'),
      ('b1', 'c2', 'Foreign Agent', 'engineer', 'Engineer', 'foreign-agent');
  `);
  return { client, db };
}

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

/**
 * Record every (sql, params) pair drizzle hands to the driver from here on (drizzle's PGlite
 * session calls `client.query(queryString, params, config)`). Returns the capture log — the
 * driver-boundary truth for what actually binds, PGlite leniency included.
 */
function spyQueries(client: PGlite): CapturedQuery[] {
  const captured: CapturedQuery[] = [];
  const original = client.query.bind(client);
  (client as unknown as {
    query: (sql: string, params?: unknown[], config?: unknown) => Promise<unknown>;
  }).query = (sqlText: string, params?: unknown[], config?: unknown) => {
    captured.push({ sql: String(sqlText), params: params ?? [] });
    return original(sqlText, params as never[], config as never);
  };
  return captured;
}

const A1 = { companyId: 'c1', agentId: 'a1' };
const B1 = { companyId: 'c2', agentId: 'b1' };

// ─── S1: per-company taskRunner settings reach the poller THROUGH the listing ────────────

describe('S1: listRunnableChatTasks carries each row company settings (runtime, not just tsc)', () => {
  it('each runnable row carries ITS OWN company settings jsonb — override, default, null', async () => {
    const { client, db } = await freshDb();
    try {
      // c1 runs an explicit taskRunner override; c2 sits at the column default {}; a third
      // company is NULL settings (LEFT-join-missing style edge: the poller must see null,
      // not a silently-defaulted block).
      await client.exec(`
        update companies set settings = '{"taskRunner":{"enabled":true,"maxConcurrentTasks":4,"maxAttemptsPerTask":3}}'::jsonb where id = 'c1';
        update companies set settings = null where id = 'c2';
      `);
      await addChatTask(A1, { title: 'Uses c1 override' }, db);
      await addChatTask(B1, { title: 'Uses c2 null settings' }, db);

      const rows = await listRunnableChatTasks(db, { limit: 10, maxAttempts: 5 });
      assert.equal(rows.length, 2);

      const c1Row = rows.find((r) => r.companyId === 'c1')!;
      const c2Row = rows.find((r) => r.companyId === 'c2')!;
      assert.ok(c1Row && c2Row, 'one row per company');

      // Mutant "drop companySettings from runnableProjection" lands here: the key would be
      // missing/undefined on EVERY row and the poller would resolve every company to defaults
      // with no error (the exact S1 gap — tsc-only until now).
      assert.ok('companySettings' in c1Row, 'c1 row exposes the settings column at all');
      assert.ok('companySettings' in c2Row, 'c2 row exposes the settings column at all');
      assert.deepEqual(c1Row.companySettings, {
        taskRunner: { enabled: true, maxConcurrentTasks: 4, maxAttemptsPerTask: 3 },
      });
      assert.equal(c2Row.companySettings, null, 'null settings stay null — never a fabricated default block');
    } finally {
      await client.close();
    }
  });

  it('two companies in the same listing never share one settings value', async () => {
    const { client, db } = await freshDb();
    try {
      await client.exec(`
        update companies set settings = '{"taskRunner":{"maxAttemptsPerTask":1}}'::jsonb where id = 'c1';
        update companies set settings = '{"taskRunner":{"maxAttemptsPerTask":5}}'::jsonb where id = 'c2';
      `);
      await addChatTask(A1, { title: 'c1 tight budget' }, db);
      await addChatTask(B1, { title: 'c2 loose budget' }, db);

      const rows = await listRunnableChatTasks(db, { limit: 10, maxAttempts: 5 });
      const byCompany = new Map(rows.map((r) => [r.companyId, r.companySettings]));
      // The rows must not collapse to one company's block (e.g. via a mis-joined projection).
      assert.deepEqual(byCompany.get('c1'), { taskRunner: { maxAttemptsPerTask: 1 } });
      assert.deepEqual(byCompany.get('c2'), { taskRunner: { maxAttemptsPerTask: 5 } });
    } finally {
      await client.close();
    }
  });
});

// ─── S2: the stale-reconcile cutoff binds as an ISO string, never a raw Date ─────────────

describe('S2: listStaleChatTaskRuns never hands the driver a raw Date (postgres-js prepare:false class)', () => {
  it('every bind param is Date-free and the cutoff arrives pre-serialised as ISO', async () => {
    const { client, db } = await freshDb();
    try {
      // The stale row: runner-claimed in_progress, linked run row MISSING (crash between
      // claim and insert), updated_at well past the cutoff → the reconciler must settle it.
      const stale = await addChatTask(A1, { title: 'Lost run' }, db);
      // Human-set in_progress (never claimed): runner_last_run_id NULL → off-limits.
      const human = await addChatTask(A1, { title: 'Human in_progress' }, db);
      // Live claimed run: heartbeat_runs row still running with a fresh last_seen_at → not stale.
      const live = await addChatTask(A1, { title: 'Live run' }, db);
      // Fresh claim inside the grace window (not backdated) → excluded by updated_at < cutoff.
      const fresh = await addChatTask(A1, { title: 'Fresh claim' }, db);

      await client.exec(`
        update chat_tasks set status = 'in_progress', runner_last_run_id = 'run-gone',
               updated_at = now() - interval '2 hours' where id = '${stale.id}';
        update chat_tasks set status = 'in_progress', updated_at = now() - interval '2 hours' where id = '${human.id}';
        update chat_tasks set status = 'in_progress', runner_last_run_id = 'run-live',
               updated_at = now() - interval '2 hours' where id = '${live.id}';
        update chat_tasks set status = 'in_progress', runner_last_run_id = 'run-fresh' where id = '${fresh.id}';
        insert into heartbeat_runs (id, company_id, agent_id, invocation_source, status, last_seen_at)
          values ('run-live', 'c1', 'a1', 'task', 'running', now());
      `);

      const captured = spyQueries(client);
      const cutoff = new Date(Date.now() - 30 * 60 * 1000);
      const rows = await listStaleChatTaskRuns(db, { staleCutoff: cutoff, limit: 10 });

      assert.deepEqual(
        rows.map((r) => r.taskId),
        [stale.id],
        'only the lost claimed row is stale (human rows, live runs and fresh claims stay)',
      );

      // The S1-proof of the #199/#202 bug CLASS: a raw Date anywhere in the bind params throws
      // ERR_INVALID_ARG_TYPE on prod postgres-js but passes PGlite — assert it can never happen.
      const dateParams = captured.flatMap((q) => q.params.filter((p) => p instanceof Date));
      assert.deepEqual(dateParams, [], `raw Date reached the driver: ${JSON.stringify(dateParams)}`);

      // And positively pin the hotfix: the deadRun template binds the ISO string, so reverting
      // the template to `${opts.staleCutoff}` (Date) fails BOTH assertions above.
      const sawIsoCutoff = captured.some((q) => q.params.includes(cutoff.toISOString()));
      assert.ok(sawIsoCutoff, 'staleCutoff bound pre-serialised as its ISO string');
      assert.ok(
        captured.some((q) => q.sql.includes('last_seen_at')),
        'the deadRun liveness template actually ran (spy observed the real query)',
      );
    } finally {
      await client.close();
    }
  });
});

// ─── S7: fair-share backfill fills the global limit without breaking fairness ─────────────

describe('S7: per-agent fair share no longer under-fills the global limit', () => {
  /** a1 gets `n` pending tasks (T00..T{n-1} in claim order), b1 always gets one. */
  async function seedBacklog(db: Awaited<ReturnType<typeof freshDb>>['db'], n: number) {
    for (let i = 0; i < n; i += 1) {
      await addChatTask(A1, { title: `T${String(i).padStart(2, '0')}` }, db);
    }
    await addChatTask(B1, { title: 'B-only' }, db);
  }

  it('A:30 + B:1 with limit 25 returns the FULL 25 — B keeps its row, A keeps claim order', async () => {
    const { client, db } = await freshDb();
    try {
      await seedBacklog(db, 30);
      const rows = await listRunnableChatTasks(db, { limit: 25, maxAttempts: 2 });

      // Pre-backfill this returned 14 (fair share 13 for A, 1 for B) — the S7 under-fill.
      assert.equal(rows.length, 25, 'global limit fully used when total backlog exceeds it');
      assert.ok(rows.some((r) => r.agentId === 'b1'), 'the small agent is never starved by the backfill');

      // A's rows stay in claim order (position, then age) across the two passes.
      const aTitles = rows.filter((r) => r.agentId === 'a1').map((r) => r.title);
      assert.deepEqual(
        aTitles,
        [...Array(24).keys()].map((i) => `T${String(i).padStart(2, '0')}`),
        'backfilled rows continue the claim-order prefix, no duplicates, no gaps',
      );
      assert.equal(new Set(rows.map((r) => r.taskId)).size, 25, 'no task listed twice');
    } finally {
      await client.close();
    }
  });

  it('backfill honours an explicit perAgentLimit (one agent cannot run away with the tick)', async () => {
    const { client, db } = await freshDb();
    try {
      await seedBacklog(db, 30);
      const rows = await listRunnableChatTasks(db, { limit: 25, maxAttempts: 2, perAgentLimit: 2 });
      const perAgent = new Map<string, number>();
      for (const r of rows) perAgent.set(r.agentId, (perAgent.get(r.agentId) ?? 0) + 1);
      assert.ok((perAgent.get('a1') ?? 0) <= 2, 'a1 capped at the caller per-agent limit');
      assert.ok((perAgent.get('b1') ?? 0) <= 2, 'b1 capped at the caller per-agent limit');
    } finally {
      await client.close();
    }
  });

  it('exhausted agents are never re-queried (backfill costs ≤ one extra chunk per full agent)', async () => {
    const { client, db } = await freshDb();
    try {
      await seedBacklog(db, 30);
      const captured = spyQueries(client);
      const rows = await listRunnableChatTasks(db, { limit: 25, maxAttempts: 2 });
      assert.equal(rows.length, 25);

      // Per-agent chunk queries are the joined ones. Expected: a1 first chunk + a1 backfill
      // chunk + b1 first chunk = 3. b1 returned fewer than its share → exhausted → never
      // queried a second time (that is its agentId bound exactly once).
      const perAgentQueries = captured.filter((q) => q.sql.includes('inner join'));
      assert.equal(perAgentQueries.length, 3, 'one re-query at most, only for agents that filled their share');
      const b1Binds = perAgentQueries.filter((q) => q.params.includes('b1')).length;
      assert.equal(b1Binds, 1, 'the exhausted agent gets exactly one query per tick');
    } finally {
      await client.close();
    }
  });
});
