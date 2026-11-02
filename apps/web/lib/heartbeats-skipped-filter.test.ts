/**
 * S295-S3 (#295 soft): the server-side `skipped` list filter actually filters.
 *
 * `runStatusCondition` in lib/heartbeats.ts maps the stored filter to a SQL
 * predicate. Without a `skipped` case the filter fell through to `default:` →
 * `undefined` → NO status condition → 'Skipped' silently degraded to 'All'
 * (six rows back, not two). Pinned against PGlite, passing `companyId` directly
 * so active-company/request scope never enters the picture.
 *
 * Mutant (S295-S3 gate M3): remove `case 'skipped'` → statusCond undefined →
 * every seeded run is returned → RED. The per-status sibling assertions keep the
 * other cases honest.
 *
 * Single test on one shared PGlite instance: node's module cache binds the
 * intercepted `db` into the imported module on FIRST load, so re-importing with
 * a second client would silently keep querying the closed first one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused';

const dbRequire = createRequire(join(__dirname, '../../../packages/db/package.json'));
const { PGlite } = dbRequire('@electric-sql/pglite');
const { drizzle } = dbRequire('drizzle-orm/pglite');
const { readMigrationFiles } = dbRequire('drizzle-orm/migrator');
const MIGRATIONS = join(__dirname, '../../../packages/db/src/migrations');

async function seededDb() {
  const client = new PGlite();
  for (const m of readMigrationFiles({ migrationsFolder: MIGRATIONS })) {
    for (const chunk of m.sql) {
      if (chunk.trim()) await client.exec(chunk);
    }
  }
  await client.exec(`
    insert into companies (id, name, slug, issue_prefix) values
      ('c1', 'Bug Hunt', 'bug-hunt', 'BH');
    insert into agents (id, company_id, name, role, title, url_key) values
      ('a1', 'c1', 'Atlas', 'engineer', 'The Engineer', 'atlas');
    insert into heartbeat_runs (id, company_id, agent_id, invocation_source, status, error_text) values
      ('r-queued',   'c1', 'a1', 'timer',      'queued',    null),
      ('r-running',  'c1', 'a1', 'assignment', 'running',   null),
      ('r-succeeded','c1', 'a1', 'assignment', 'succeeded', null),
      ('r-failed',   'c1', 'a1', 'assignment', 'failed',    'boom'),
      ('r-skip-1',   'c1', 'a1', 'assignment', 'skipped',   'Task issue-9 is assigned to agent other, not a1'),
      ('r-skip-2',   'c1', 'a1', 'task',       'skipped',   'Task issue-10 is assigned to agent other, not a1');
  `);
  return { client, db: drizzle(client) };
}

async function loadHeartbeats(db: unknown) {
  const Module = require('module');
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function (this: { filename?: string }, id: string) {
    if (id === '@tourbillon/db') {
      return { ...(originalRequire.apply(this, arguments as unknown as [string]) as object), db };
    }
    if (id === './company') {
      return {
        getActiveCompanyOrNull: async () => ({ id: 'c1' }),
        getActiveCompany: async () => ({ id: 'c1' }),
      };
    }
    return originalRequire.apply(this, arguments as unknown as [string]);
  };
  try {
    return await import('./heartbeats');
  } finally {
    Module.prototype.require = originalRequire;
  }
}

describe('getHeartbeatList: skipped filter reaches the DB predicate (S295-S3, #295)', () => {
  it('filter=skipped narrows to skipped runs; all keeps them; siblings stay single-status', async () => {
    const { client, db } = await seededDb();
    try {
      const heartbeats = await loadHeartbeats(db);

      const skipped = await heartbeats.getHeartbeatList({ filter: 'skipped', companyId: 'c1' });
      assert.equal(skipped.filter, 'skipped');
      // M3 bait: a dropped case collapses this to 6 (no predicate at all).
      assert.equal(skipped.total, 2, 'count query must carry the skipped predicate');
      assert.deepEqual(skipped.entries.map((e) => e.key).sort(), ['r-skip-1', 'r-skip-2']);
      assert.ok(skipped.entries.every((e) => e.runStatus === 'skipped'));
      // The skip reason (errorText) must reach the list row for triage.
      assert.ok(skipped.entries[0]!.errorText?.includes('assigned to agent'));

      const all = await heartbeats.getHeartbeatList({ filter: 'all', companyId: 'c1' });
      assert.equal(all.total, 6, 'skipped runs were always visible under All — keep that');

      for (const [filter, expected] of [
        ['queued', ['r-queued']],
        ['running', ['r-running']],
        ['succeeded', ['r-succeeded']],
        ['failed', ['r-failed']],
      ] as const) {
        const res = await heartbeats.getHeartbeatList({ filter, companyId: 'c1' });
        assert.deepEqual(res.entries.map((e) => e.key), expected, `filter=${filter}`);
      }
    } finally {
      await client.close();
    }
  });
});
