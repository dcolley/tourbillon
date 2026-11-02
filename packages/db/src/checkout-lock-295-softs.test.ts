/**
 * #295 S295-S1: the checkout-lock staleness rule must treat EVERY terminal heartbeat
 * status as stale — pinned against PGlite with the repo's own migrations.
 *
 * The hole Test found on #295: `skipped` sat in checkout-lock.ts's TERMINAL_HEARTBEAT_STATUSES
 * with no test row, so deleting it (mutant M4) survived the whole suite — a run that had
 * already skipped (e.g. the #275 assignee-mismatch pre-flight) could keep an issue's
 * checkout lock hostage: isStaleCheckoutRun said "not stale", nothing ever called
 * releaseStaleCheckoutLocksForRun, and the issue stayed locked against a dead run.
 *
 * The set is now the single source of truth in @tourbillon/shared (shared with the
 * scheduler's recordHeartbeatFailure / recordHeartbeatSkip guards, S295-S4), so the M4 drop
 * is made in packages/shared/src/terminal-heartbeat-statuses.ts and must go RED here, on
 * every member. Non-terminal `queued` / `running` must stay NOT stale (a live run legitimately
 * holds its lock), a missing run row is stale, and a null runId locks nothing.
 */
import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';

// checkout-lock.ts loads the app pool at import; it only validates the URL format
// (no connection is opened — every query below goes through the swapped PGlite instance).
process.env.DATABASE_URL ??= 'postgres://user:***@127.0.0.1:5432/unused';

import * as schema from './schema/index';
import { db } from './client';
import { isStaleCheckoutRun, releaseStaleCheckoutLocksForRun } from './checkout-lock';
import { TERMINAL_HEARTBEAT_STATUSES } from '@tourbillon/shared';

const MIGRATIONS = path.join(__dirname, 'migrations');

/** Every HeartbeatStatus value, written out independently of the set under test. */
const ALL_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'coalesced',
  'skipped',
] as const;
// Guard the fixture itself: if the union grows, this suite must grow with it.
assert.equal(
  ALL_STATUSES.length,
  7,
  'heartbeat-runs HeartbeatStatus union changed — extend ALL_STATUSES (checkout-activity/295 pins)',
);
/**
 * The canonical terminal set, written independently of TERMINAL_HEARTBEAT_STATUSES. The
 * staleness expectations below come from THIS list — deriving them from the set under test
 * would make the M4 mutant (drop `skipped`) flip expected and behaviour together and survive.
 * The membership pin below binds the shared set to this list.
 */
const CANONICAL_TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'coalesced', 'skipped']);

async function migrateUp(client: PGlite): Promise<void> {
  await client.exec(`
    create schema if not exists drizzle;
    create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
  `);
  for (const m of readMigrationFiles({ migrationsFolder: MIGRATIONS })) {
    for (const chunk of m.sql) {
      if (chunk.trim()) await client.exec(chunk);
    }
    await client.query('insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)', [
      m.hash,
      m.folderMillis,
    ]);
  }
}

describe('#295 S295-S1 isStaleCheckoutRun per-status pins (PGlite)', () => {
  let client: PGlite;

  before(async () => {
    client = new PGlite();
    await migrateUp(client);
    const pgliteDb = drizzle(client, { schema });
    await client.exec(`
      insert into companies (id, name, slug, issue_prefix) values ('c1', 'Bug Hunt', 'bug-hunt', 'BH');
      insert into agents (id, company_id, name, role, title, url_key) values ('a1', 'c1', 'Assistant', 'cto', 'The Assistant', 'assistant');
    `);
    // checkout-lock.ts closes over the postgres-js singleton; swap its query/update API
    // onto the migrated PGlite instance (same pattern the other db suites use to keep the
    // app pool untouched).
    (db as { query: unknown }).query = pgliteDb.query;
    (db as { update: unknown }).update = pgliteDb.update.bind(pgliteDb);
  });

  after(async () => {
    await client.close();
  });

  beforeEach(async () => {
    await client.exec('delete from issues');
    await client.exec('delete from heartbeat_runs');
  });

  async function seedRun(id: string, status: string): Promise<void> {
    await client.query(
      `insert into heartbeat_runs (id, company_id, agent_id, invocation_source, status, started_at)
       values ($1, 'c1', 'a1', 'assignment', $2, now())`,
      [id, status],
    );
  }

  it('the shared terminal set is exactly the canonical five (membership pin)', () => {
    assert.deepEqual(
      [...(TERMINAL_HEARTBEAT_STATUSES as ReadonlySet<string>)].sort(),
      [...CANONICAL_TERMINAL].sort(),
      'the shared terminal set drifted from the canonical list this suite pins behaviour against',
    );
  });

  for (const status of ALL_STATUSES) {
    const expectStale = CANONICAL_TERMINAL.has(status);
    it(`a lock held by a '${status}' run is ${expectStale ? 'stale' : 'NOT stale'}`, async () => {
      await seedRun(`run-${status}`, status);
      const stale = await isStaleCheckoutRun(`run-${status}`);
      assert.equal(
        stale,
        expectStale,
        expectStale
          ? `'${status}' is a terminal heartbeat status — a lock held by a ${status} run must be ` +
            `reclaimable (dropping it from the shared terminal set leaves issues locked against a dead run)`
          : `'${status}' is NOT terminal — a live run legitimately holds its checkout lock`,
      );
    });
  }

  it('a run row that has vanished is stale', async () => {
    assert.equal(await isStaleCheckoutRun('run-gone'), true);
  });

  it('a null/undefined checkoutRunId locks nothing (not stale)', async () => {
    assert.equal(await isStaleCheckoutRun(null), false);
    assert.equal(await isStaleCheckoutRun(undefined), false);
  });

  it('releaseStaleCheckoutLocksForRun clears locks held by the run', async () => {
    await seedRun('run-dead', 'skipped');
    await client.exec(`
      insert into issues (id, company_id, identifier, title, status, checkout_run_id)
      values
        ('i1', 'c1', 'BH-1', 'Locked by the dead run', 'in_progress', 'run-dead'),
        ('i2', 'c1', 'BH-2', 'Never locked', 'todo', null);
    `);

    const released = await releaseStaleCheckoutLocksForRun('run-dead');
    assert.equal(released, 1);

    const rows = await client.query<{ id: string; checkout_run_id: string | null }>(
      'select id, checkout_run_id from issues order by id',
    );
    assert.equal(rows.rows[0]!.checkout_run_id, null, 'the dead run must lose its lock');
    assert.equal(rows.rows[1]!.checkout_run_id, null);
  });
});
