/**
 * S295-S3 (#295 soft): `getQueueOverview` must count `skipped` heartbeat runs.
 *
 * #275/#295 added a `skipped` heartbeat_runs status (assignee-mismatch task-scoped
 * wakes are skipped, never failed). Before this soft the /jobs overview counted it
 * nowhere — a skipped run vanished from every bucket. Pinned here against a real
 * in-memory Postgres (PGlite), same harness pattern as
 * lib/activity-company-scope.test.ts: intercept the `@tourbillon/db` require with
 * the real module plus a PGlite-backed `db`, stub `./company` (active-company
 * needs request scope), then drive the REAL getQueueOverview.
 *
 * Mutant (S295-S3 gate M1): drop the `else if (row.status === 'skipped')` line in
 * jobs.ts → counts.skipped stays 0 → this file goes RED while every other bucket
 * stays green (specificity: the mutant only removes the skipped branch).
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

describe('getQueueOverview: skipped heartbeat runs are counted (S295-S3, #295)', () => {
  it('counts skipped runs in their own bucket without disturbing the others', async () => {
    const { client, db } = await seededDb();
    try {
      const Module = require('module');
      const originalRequire = Module.prototype.require;
      Module.prototype.require = function (this: { filename?: string }, id: string) {
        if (id === '@tourbillon/db') {
          return { ...(originalRequire.apply(this, arguments as unknown as [string]) as object), db };
        }
        if (id === './company') {
          // Active-company resolution needs request scope (cookies/headers); the
          // overview only consumes company.id.
          return {
            getActiveCompanyOrNull: async () => ({ id: 'c1' }),
            getActiveCompany: async () => ({ id: 'c1' }),
          };
        }
        return originalRequire.apply(this, arguments as unknown as [string]);
      };
      let jobs: typeof import('./jobs');
      try {
        jobs = await import('./jobs');
      } finally {
        Module.prototype.require = originalRequire;
      }

      const { queues, redisOk } = await jobs.getQueueOverview();
      assert.ok(redisOk);
      assert.equal(queues.length, 1);
      const counts = queues[0]!.counts;

      // M1 bait: removing the skipped branch leaves this at 0.
      assert.equal(counts.skipped, 2, 'both skipped runs must land in counts.skipped');
      // Sibling buckets keep their exact meaning — the skipped branch must not
      // siphon rows from failed/completed (a `failed` run is NOT a skip).
      assert.equal(counts.waiting, 1);
      assert.equal(counts.active, 1);
      assert.equal(counts.completed, 1);
      assert.equal(counts.failed, 1);
      assert.equal(counts.delayed, 0);
      assert.equal(counts.paused, 0);
    } finally {
      await client.close();
    }
  });
});
