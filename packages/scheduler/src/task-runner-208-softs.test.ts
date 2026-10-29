/**
 * #208 ACCEPT softs S5 — REAL-DB run of the whole `createDefaultTaskRunnerDeps().listRunnable`
 * path: company settings read → per-company RESOLVED caps → CASE filter → fair-share rows,
 * against PGlite with the repo's own migrations applied.
 *
 * The pre-existing coverage for this path (task-runner.test.ts `fakeListDb`) only captures the
 * WHERE params on a FAKE db — it never executes either query. So a broken settings read, a
 * mis-bound CASE param, or a projection regression in either db query stayed green. Here the
 * real `listRunnable` closure runs against a real Postgres (in-process): c1 runs a tightened
 * budget (maxAttemptsPerTask 1 — its over-budget row must NOT be listed), c2 a loose one (5 —
 * its attempts=4 row MUST be listed), and a paused row must never enter either the company map
 * or the listing. Reverting the closure to a fixed bound, or skipping the company read, lands
 * here at runtime instead of passing silently.
 *
 * PGlite is a devDependency of '@tourbillon/db' only; it is resolved through that package's
 * manifest with createRequire (same portable pattern as apps/web feedback-store.test.ts), so
 * the scheduler needs no dependency of its own. './wake-runner' + redis-pub are only reached
 * through startWake/emitProgress — listRunnable never touches them, so no redis stub is needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { addChatTask, setChatTaskPaused } from '@tourbillon/db';
import * as schema from '@tourbillon/db/schema';
import { spyQueries } from '@tourbillon/db/test/query-spy';
import type { ChatTaskDb } from '@tourbillon/db';
import { createDefaultTaskRunnerDeps } from './task-runner';

// task-runner.ts imports @tourbillon/db at module load, which validates DATABASE_URL eagerly.
process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused';

const dbRequire = createRequire(path.join(__dirname, '../../db/package.json'));

/** Structural surface we actually use — PGlite is not a scheduler dependency, so no types. */
interface PGliteLike {
  exec(sql: string): Promise<unknown>;
  query(sql: string, params?: unknown[], config?: unknown): Promise<unknown>;
  close(): Promise<void>;
}
const { PGlite } = dbRequire('@electric-sql/pglite') as { PGlite: new () => PGliteLike };
const { drizzle: drizzlePg } = dbRequire('drizzle-orm/pglite') as {
  drizzle: (client: unknown, options: { schema: unknown }) => ChatTaskDb;
};

const MIGRATIONS = path.join(__dirname, '../../db/src/migrations');
const JOURNAL = (
  JSON.parse(
    readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { tag: string; when: number }[] }
).entries;
const WHEN_LATEST = JOURNAL[JOURNAL.length - 1]!.when;

/** Apply every migration in the journal (same rule as drizzle's migrator / the db test suites). */
async function migrateUp(client: PGliteLike): Promise<void> {
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

/**
 * c1: settings.taskRunner.maxAttemptsPerTask = 1 (tight). c2: maxAttemptsPerTask = 5 (loose).
 * Three active agents: a1 + a2 in c1, b1 in c2.
 */
async function freshDb() {
  const client = new PGlite();
  await migrateUp(client);
  const db = drizzlePg(client, { schema });
  await client.exec(`
    insert into companies (id, name, slug, issue_prefix, settings) values
      ('c1', 'Tight Co', 'tight', 'TC', '{"taskRunner":{"maxAttemptsPerTask":1}}'::jsonb),
      ('c2', 'Loose Co', 'loose', 'LC', '{"taskRunner":{"maxAttemptsPerTask":5}}'::jsonb);
    insert into agents (id, company_id, name, role, title, url_key) values
      ('a1', 'c1', 'Tight Bot', 'cto', 'The Assistant', 'tight-bot'),
      ('a2', 'c1', 'Twin Bot', 'engineer', 'Engineer', 'twin-bot'),
      ('b1', 'c2', 'Loose Bot', 'engineer', 'Engineer', 'loose-bot');
  `);
  return { client, db };
}

const A1 = { companyId: 'c1', agentId: 'a1' };
const A2 = { companyId: 'c1', agentId: 'a2' };
const B1 = { companyId: 'c2', agentId: 'b1' };

// spyQueries (#213 S6c) is the shared helper from '@tourbillon/db/test/query-spy' — one
// driver-boundary spy for the two db chat-task suites and this file.

test('S5: listRunnable end-to-end — resolved per-company budgets travel company read → CASE → rows (real PGlite)', async () => {
  const { client, db } = await freshDb();
  try {
    // c1 budget 1: attempts=1 is OVER budget → must drop out of the listing.
    const tOver = await addChatTask(A1, { title: 'Over the tight budget' }, db);
    await client.query('update chat_tasks set runner_attempts = 1 where id = $1', [tOver.id]);
    // c1 budget 1: attempts=0 still lists (per-row, not per-company starvation).
    const tOk = await addChatTask(A1, { title: 'Under the tight budget' }, db);
    // c1: the only pending row of a2, paused — never in the company map, never in the rows.
    const tPaused = await addChatTask(A2, { title: 'Paused tight' }, db);
    await setChatTaskPaused(A2, { id: tPaused.id, paused: true }, db);
    // c2 budget 5: attempts=4 lists — a fixed/default cap of 2 would wrongly starve it.
    const tLoose = await addChatTask(B1, { title: 'Inside the loose budget' }, db);
    await client.query('update chat_tasks set runner_attempts = 4 where id = $1', [tLoose.id]);

    const captured = spyQueries(client);
    const deps = createDefaultTaskRunnerDeps({
      database: db,
      log: { info: () => undefined },
      startWake: async () => {
        throw new Error('listRunnable must not start wakes');
      },
    });

    const rows = await deps.listRunnable();
    assert.deepEqual(
      rows.map((r) => r.taskId),
      [tOk.id, tLoose.id],
      'tight-budget over-spent row and paused row excluded; loose-budget row at attempts=4 kept',
    );

    // The rows carry their OWN company settings block (the poller resolves these again).
    const okRow = rows.find((r) => r.taskId === tOk.id)!;
    const looseRow = rows.find((r) => r.taskId === tLoose.id)!;
    assert.deepEqual(okRow.companySettings, { taskRunner: { maxAttemptsPerTask: 1 } });
    assert.deepEqual(looseRow.companySettings, { taskRunner: { maxAttemptsPerTask: 5 } });

    // The CASE rode the REAL driver with the RESOLVED budgets as bind params — not a fixed 5,
    // and not a fake-dialect translation (which is all the old coverage asserted).
    const caseQuery = captured.find((q) => /\bcase\b/i.test(q.sql) && /runner_attempts/i.test(q.sql));
    assert.ok(caseQuery, 'the per-company CASE query actually ran through the driver');
    const iC1 = caseQuery!.params.indexOf('c1');
    const iC2 = caseQuery!.params.indexOf('c2');
    assert.ok(iC1 >= 0 && iC2 >= 0, `both company ids bind into the CASE: ${JSON.stringify(caseQuery!.params)}`);
    assert.equal(caseQuery!.params[iC1 + 1], 1, 'c1 binds its OWN resolved budget (1)');
    assert.equal(caseQuery!.params[iC2 + 1], 5, 'c2 binds its OWN resolved budget (5)');

    // The company-settings read that fed the map also ran through the driver with the
    // pending+unpaused filter — the paused row never entered it.
    const companyRead = captured.find((q) => /group by/i.test(q.sql));
    assert.ok(companyRead, 'the company settings read actually ran');
    assert.ok(companyRead!.params.includes('pending') && companyRead!.params.includes(false),
      'the company read filtered pending + unpaused at the driver');
  } finally {
    await client.close();
  }
});

test('S5: listRunnable with no pending work — empty map, no CASE, empty listing (real PGlite)', async () => {
  const { client, db } = await freshDb();
  try {
    // Only a paused row and a done row exist: the company read sees nothing, so the listing
    // runs the empty-map branch and returns []. NOTE (#213 S6b): this exercises the empty-map
    // branch only STRUCTURALLY — with nothing pending there is no row for the fallback bound
    // to judge, so the #208 S3 bound (5, shared with the CASE ELSE) is NOT asserted here and
    // the S3 5→2 mutant stays green in this file. That bound is pinned by the db suite
    // (chat-task-queries.test.ts, 'S3: the EMPTY map uses the SAME fallback bound 5').
    const paused = await addChatTask(A1, { title: 'Paused only' }, db);
    await setChatTaskPaused(A1, { id: paused.id, paused: true }, db);
    await addChatTask(B1, { title: 'Done only', status: 'done' }, db);

    const deps = createDefaultTaskRunnerDeps({ database: db, log: { info: () => undefined } });
    assert.deepEqual(await deps.listRunnable(), [], 'nothing pending unpaused → empty listing');

    // Race a pending row in at attempts=2 and re-poll. On THIS poll the company read sees c1,
    // so the row is judged through the CASE path against c1's resolved budget (1) — excluded.
    // What this pins is the map path end-to-end (settings read → resolved budget → CASE bind
    // → exclusion); it is deliberately NOT the S3 empty-map bound (see the note above).
    const raced = await addChatTask(A1, { title: 'Raced in' }, db);
    await client.query('update chat_tasks set runner_attempts = 2 where id = $1', [raced.id]);
    assert.deepEqual((await deps.listRunnable()).map((r) => r.taskId), [],
      'c1 resolved budget 1 excludes the attempts=2 row via the CASE (map path works)');
  } finally {
    await client.close();
  }
});

// #216 S7a — '@tourbillon/db/test/query-spy' is gated behind the "tourbillon-test" package-
// exports condition (packages/db/package.json), so a naive production import
// (`import '@tourbillon/db/test/query-spy'`) fails to resolve from apps/web and
// packages/mastra (ERR_PACKAGE_PATH_NOT_EXPORTED — verified in the PR body). Caveat: tsx
// resolves through tsconfig `paths`, so this package's own test files still reach it, and a
// scheduler PRODUCTION file could too. The accepted workspace-only floor: no non-test file in
// any production path may reference the subpath at all. This static pin enforces that floor —
// if the exports gate is ever removed, this test remains the wall.
test('S7a pin: no production file imports @tourbillon/db/test/query-spy', () => {
  let repoRoot = __dirname;
  while (repoRoot !== path.dirname(repoRoot) && !existsSync(path.join(repoRoot, 'pnpm-workspace.yaml'))) {
    repoRoot = path.dirname(repoRoot);
  }
  assert.ok(existsSync(path.join(repoRoot, 'pnpm-workspace.yaml')), 'walked up to the pnpm workspace root');

  const FORBIDDEN = '@tourbillon/db/test/query-spy';
  const SKIP_DIRS = new Set(['node_modules', '.next', '.turbo', 'dist', 'build', 'migrations']);
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        const file = path.join(dir, entry.name);
        if (readFileSync(file, 'utf8').includes(FORBIDDEN)) {
          hits.push(path.relative(repoRoot, file));
        }
      }
    }
  };
  for (const prod of ['apps/web', 'packages/mastra/src', 'packages/scheduler/src']) {
    walk(path.join(repoRoot, prod));
  }
  assert.deepEqual(hits, [], 'only *.test.ts files may import the gated test-only subpath');
});
