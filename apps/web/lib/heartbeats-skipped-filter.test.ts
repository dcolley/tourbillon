/**
 * S295-S3 / S298-S1 (#295, #298): the server-side status list filters actually filter.
 *
 * `runStatusCondition` in lib/heartbeats.ts maps the stored filter to a SQL
 * predicate. Without a `skipped` case (S295-S3) — or, before S298-S1, without the
 * `coalesced` / `cancelled` cases — the filter fell through to `default:` →
 * `undefined` → NO status condition → the filter silently degraded to 'All'
 * (every row back, not the handful it should narrow to). Pinned against PGlite,
 * passing `companyId` directly so active-company/request scope never enters the
 * picture. The loop is driven by TERMINAL_HEARTBEAT_STATUSES: a future terminal
 * status without a filter case fails here, not in the UI.
 *
 * Mutants (S295-S3 gate M3): remove `case 'skipped'` → statusCond undefined →
 * every seeded run is returned → RED. S298-S1 gate: remove `case 'coalesced'` (or
 * 'cancelled') → that filter degrades to all rows → RED; sibling filters stay green
 * (specificity).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { TERMINAL_HEARTBEAT_STATUSES } from '@tourbillon/shared/terminal-heartbeat-statuses';
import type { HeartbeatListFilter } from './heartbeat-list-storage';

process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1/unused';

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
      ('r-queued',    'c1', 'a1', 'timer',      'queued',    null),
      ('r-running',   'c1', 'a1', 'assignment', 'running',   null),
      ('r-succeeded', 'c1', 'a1', 'assignment', 'succeeded', null),
      ('r-failed',    'c1', 'a1', 'assignment', 'failed',    'boom'),
      ('r-skip-1',    'c1', 'a1', 'assignment', 'skipped',   'Task issue-9 is assigned to agent other, not a1'),
      ('r-skip-2',    'c1', 'a1', 'task',       'skipped',   'Task issue-10 is assigned to agent other, not a1'),
      ('r-coalesced', 'c1', 'a1', 'timer',      'coalesced', 'coalesced into a newer wake'),
      ('r-cancelled', 'c1', 'a1', 'on_demand',  'cancelled', 'operator force-killed the wake');
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

// Every terminal HeartbeatStatus doubles as a list filter value (HeartbeatStatus ⊂
// HeartbeatListFilter — a new status without a filter case turns this RED in tsc).
const TERMINAL_FILTERS: HeartbeatListFilter[] = [...TERMINAL_HEARTBEAT_STATUSES];

const TERMINAL_KEYS: Record<string, string[]> = {
  succeeded: ['r-succeeded'],
  failed: ['r-failed'],
  skipped: ['r-skip-1', 'r-skip-2'],
  coalesced: ['r-coalesced'],
  cancelled: ['r-cancelled'],
};

describe('getHeartbeatList: every terminal status filter reaches the DB predicate (S295-S3 + S298-S1)', () => {
  it('each terminal filter narrows to its own runs; all keeps them; siblings stay single-status', async () => {
    const { client, db } = await seededDb();
    try {
      const heartbeats = await loadHeartbeats(db);

      const skipped = await heartbeats.getHeartbeatList({ filter: 'skipped', companyId: 'c1' });
      assert.equal(skipped.filter, 'skipped');
      // M3 bait (S295-S3): a dropped case collapses this to 8 (no predicate at all).
      assert.equal(skipped.total, 2, 'count query must carry the skipped predicate');
      assert.deepEqual(skipped.entries.map((e) => e.key).sort(), ['r-skip-1', 'r-skip-2']);
      assert.ok(skipped.entries.every((e) => e.runStatus === 'skipped'));
      // The skip reason (errorText) must reach the list row for triage.
      assert.ok(skipped.entries[0]!.errorText?.includes('assigned to agent'));

      const all = await heartbeats.getHeartbeatList({ filter: 'all', companyId: 'c1' });
      assert.equal(all.total, 8, 'terminal runs were always visible under All — keep that');

      // Per-terminal-status pins (S298-S1): coalesced and cancelled narrow exactly
      // like skipped does; the error reason rides along on each row.
      for (const filter of TERMINAL_FILTERS) {
        const res = await heartbeats.getHeartbeatList({ filter, companyId: 'c1' });
        assert.equal(res.filter, filter);
        assert.deepEqual(
          res.entries.map((e) => e.key).sort(),
          TERMINAL_KEYS[filter]!,
          `filter=${filter} must narrow to its own rows`,
        );
        assert.ok(res.entries.every((e) => e.runStatus === filter), `filter=${filter} purity`);
        assert.equal(res.total, TERMINAL_KEYS[filter]!.length, `filter=${filter} count query`);
      }

      // Non-terminal siblings keep their single-status meaning.
      for (const [filter, expected] of [
        ['queued', ['r-queued']],
        ['running', ['r-running']],
      ] as const) {
        const res = await heartbeats.getHeartbeatList({ filter, companyId: 'c1' });
        assert.deepEqual(res.entries.map((e) => e.key), expected, `filter=${filter}`);
      }
    } finally {
      await client.close();
    }
  });
});
