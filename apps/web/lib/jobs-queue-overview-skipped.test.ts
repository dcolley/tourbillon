/**
 * S295-S3 / S298-S1 (#295, #298): `getQueueOverview` must count EVERY terminal
 * heartbeat_runs status in its own bucket.
 *
 * #275/#295 added `skipped`; S298-S1 added the symmetric treatment for
 * `coalesced` and `cancelled` (both valid HeartbeatStatus terminal states per
 * @tourbillon/shared/terminal-heartbeat-statuses). Before #298 both vanished from
 * every bucket. Pinned against a real in-memory Postgres (PGlite), same harness
 * pattern as lib/activity-company-scope.test.ts: intercept the `@tourbillon/db`
 * require with the real module plus a PGlite-backed `db`, stub `./company`
 * (active-company needs request scope), then drive the REAL getQueueOverview.
 *
 * The loop is driven by TERMINAL_HEARTBEAT_STATUSES itself: a future terminal
 * status with no bucket fails at runtime (assert.ok on the map lookup), and a
 * HeartbeatStatus member missing from STATUS_BUCKET fails at compile time
 * (Record<HeartbeatStatus, ...>) under `pnpm -r type-check`.
 *
 * Mutants (S298-S1 gate): drop the `else if (row.status === 'coalesced')` line in
 * jobs.ts → counts.coalesced stays 0 → RED while every sibling bucket stays green
 * (specificity). Legacy M1 (S295-S3): drop the `skipped` line → counts.skipped 0 → RED.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { TERMINAL_HEARTBEAT_STATUSES } from '@tourbillon/shared/terminal-heartbeat-statuses';
import type { HeartbeatStatus } from '@tourbillon/db/schema';
import type { QueueCounts } from './jobs';

process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1/unused';

const dbRequire = createRequire(join(__dirname, '../../../packages/db/package.json'));
const { PGlite } = dbRequire('@electric-sql/pglite');
const { drizzle } = dbRequire('drizzle-orm/pglite');
const { readMigrationFiles } = dbRequire('drizzle-orm/migrator');
const MIGRATIONS = join(__dirname, '../../../packages/db/src/migrations');

/** Every HeartbeatStatus maps to the overview bucket that must carry it. */
const STATUS_BUCKET: Record<HeartbeatStatus, keyof QueueCounts> = {
  queued: 'waiting',
  running: 'active',
  succeeded: 'completed',
  failed: 'failed',
  skipped: 'skipped',
  coalesced: 'coalesced',
  cancelled: 'cancelled',
};

const STATUS_ERROR_TEXT: Partial<Record<HeartbeatStatus, string>> = {
  skipped: 'Task issue-9 is assigned to agent other, not a1',
  coalesced: 'coalesced into a newer wake',
  cancelled: 'operator force-killed the wake',
  failed: 'boom',
};

async function seededDb() {
  const client = new PGlite();
  for (const m of readMigrationFiles({ migrationsFolder: MIGRATIONS })) {
    for (const chunk of m.sql) {
      if (chunk.trim()) await client.exec(chunk);
    }
  }
  // Two rows per terminal status (assignment + task source) plus one queued and
  // one running, so each bucket's count is unambiguous.
  await client.exec(`
    insert into companies (id, name, slug, issue_prefix) values
      ('c1', 'Bug Hunt', 'bug-hunt', 'BH');
    insert into agents (id, company_id, name, role, title, url_key) values
      ('a1', 'c1', 'Atlas', 'engineer', 'The Engineer', 'atlas');
    insert into heartbeat_runs (id, company_id, agent_id, invocation_source, status, error_text) values
      ('r-queued',  'c1', 'a1', 'timer', 'queued',  null),
      ('r-running', 'c1', 'a1', 'timer', 'running', null),
      ${[...TERMINAL_HEARTBEAT_STATUSES]
        .flatMap((status) =>
          (['assignment', 'task'] as const).map(
            (source, j) =>
              `('r-${status}-${j + 1}', 'c1', 'a1', '${source}', '${status}', ${
                STATUS_ERROR_TEXT[status] ? `'${STATUS_ERROR_TEXT[status]}'` : 'null'
              })`,
          ),
        )
        .join(',\n      ')};
  `);
  return { client, db: drizzle(client) };
}

describe('getQueueOverview: every terminal heartbeat status is counted (S295-S3 + S298-S1)', () => {
  it('counts skipped/coalesced/cancelled in their own buckets without disturbing the others', async () => {
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

      // Per-terminal-status pins (S298-S1): every member of the shared terminal set
      // lands in its bucket — no silent vanish, including coalesced and cancelled.
      for (const status of TERMINAL_HEARTBEAT_STATUSES) {
        const bucket = STATUS_BUCKET[status];
        assert.ok(bucket, `terminal status '${status}' must have an overview bucket`);
        assert.equal(counts[bucket], 2, `2 '${status}' runs must land in counts.${bucket}`);
      }
      // Legacy M1 bait (S295-S3): removing the skipped branch leaves this at 0.
      assert.equal(counts.skipped, 2, 'both skipped runs must land in counts.skipped');
      // Sibling buckets keep their exact meaning — the new branches must not siphon
      // rows from completed/failed (a `failed` run is NOT a skip) and non-terminal
      // statuses must not leak into the new buckets.
      assert.equal(counts.waiting, 1);
      assert.equal(counts.active, 1);
      assert.equal(counts.delayed, 0);
      assert.equal(counts.paused, 0);
    } finally {
      await client.close();
    }
  });
});
