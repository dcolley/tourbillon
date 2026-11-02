/**
 * S295-S3 (#295 soft): observability rows must surface `heartbeatRunStatus: 'skipped'`.
 *
 * `heartbeatRunStatusForRow` in lib/observability.ts whitelisted running/succeeded/
 * failed and mapped everything else — including the new #295 `skipped` status — to
 * null, so an observability row linked to a skipped run showed NO run status.
 * Pinned against PGlite (real migrations, real loader): one event per linked run
 * status, plus an orphan event.
 *
 * Mutant (S295-S3 gate M4): drop `run.status === 'skipped'` from the whitelist →
 * the skipped row maps to null → RED. M5 (remove 'skipped' from the
 * ObservabilityEventRow union in observability-types.ts) is a compile-time pin:
 * the tsc assertion at the bottom of this file plus the whitelist's return type
 * turn it RED for `pnpm -r type-check` (tsx strips types at test time).
 *
 * Scope note: `coalesced` still maps to null — kept as-is deliberately (noted in
 * this PR's body; widening scope was explicitly declined).
 */
import { describe, it, after } from 'node:test';
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
      ('r-running',  'c1', 'a1', 'assignment', 'running',   null),
      ('r-succeeded','c1', 'a1', 'assignment', 'succeeded', null),
      ('r-failed',   'c1', 'a1', 'assignment', 'failed',    'boom'),
      ('r-skipped',  'c1', 'a1', 'assignment', 'skipped',   'Task issue-9 is assigned to agent other, not a1'),
      ('r-coalesced','c1', 'a1', 'timer',      'coalesced', 'coalesced into a newer wake');
    insert into agent_observability_events
      (id, company_id, trace_id, span_id, event_type, name, status, heartbeat_run_id, occurred_at) values
      ('e-1', 'c1', 'tr-run', 'sp-1', 'agent_run', 'wake-running',  'ok', 'r-running',   '2026-11-01T00:01:00Z'),
      ('e-2', 'c1', 'tr-run', 'sp-2', 'agent_run', 'wake-ok',       'ok', 'r-succeeded', '2026-11-01T00:02:00Z'),
      ('e-3', 'c1', 'tr-run', 'sp-3', 'agent_run', 'wake-failed',   'ok', 'r-failed',    '2026-11-01T00:03:00Z'),
      ('e-4', 'c1', 'tr-run', 'sp-4', 'agent_run', 'wake-skipped',  'ok', 'r-skipped',   '2026-11-01T00:04:00Z'),
      ('e-5', 'c1', 'tr-run', 'sp-5', 'agent_run', 'wake-coalesced','ok', 'r-coalesced', '2026-11-01T00:05:00Z'),
      ('e-6', 'c1', 'tr-run', 'sp-6', 'agent_run', 'wake-orphan',   'ok', null,          '2026-11-01T00:06:00Z');
  `);
  return { client, db: drizzle(client) };
}

async function loadObservability(db: unknown) {
  const Module = require('module');
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function (this: { filename?: string }, id: string) {
    if (id === '@tourbillon/db') {
      return { ...(originalRequire.apply(this, arguments as unknown as [string]) as object), db };
    }
    return originalRequire.apply(this, arguments as unknown as [string]);
  };
  try {
    return await import('./observability');
  } finally {
    Module.prototype.require = originalRequire;
  }
}

// One client for the whole file: node's module cache binds the intercepted `db`
// into the imported module on FIRST load, so a second seeded client per test
// would silently keep querying the closed first one.
let shared: { client: InstanceType<typeof PGlite>; observability: Awaited<ReturnType<typeof loadObservability>> } | null = null;
async function sharedObservability() {
  if (!shared) {
    const { client, db } = await seededDb();
    shared = { client, observability: await loadObservability(db) };
  }
  return shared;
}
after(async () => {
  await shared?.client.close();
});

describe('observability heartbeatRunStatus: skipped maps through (S295-S3, #295)', () => {
  it('listObservabilityEvents exposes skipped (and keeps siblings + coalesced as-is)', async () => {
    const { observability } = await sharedObservability();
    const result = await observability.listObservabilityEvents({
      companyId: 'c1',
      pageSize: 50,
    });
    const byName = new Map(result.events.map((e) => [e.name, e]));
    assert.equal(result.total, 6);

    const skipped = byName.get('wake-skipped');
    assert.ok(skipped);
    // M4 bait: removing 'skipped' from the whitelist yields null here.
    assert.equal(skipped!.heartbeatRunStatus, 'skipped');
    assert.ok(
      skipped!.heartbeatRunErrorText?.includes('assigned to agent'),
      'the skip reason must ride along for triage',
    );

    assert.equal(byName.get('wake-running')!.heartbeatRunStatus, 'running');
    assert.equal(byName.get('wake-ok')!.heartbeatRunStatus, 'succeeded');
    assert.equal(byName.get('wake-failed')!.heartbeatRunStatus, 'failed');
    assert.equal(byName.get('wake-coalesced')!.heartbeatRunStatus, null,
      'coalesced handling kept as-is (out of scope, noted in PR body)');
    assert.equal(byName.get('wake-orphan')!.heartbeatRunStatus, null);
    assert.equal(byName.get('wake-orphan')!.heartbeatRunErrorText, null);
  });

  it('getObservabilityEvent (single row) exposes skipped too', async () => {
    const { observability } = await sharedObservability();
    const rows = await observability.listObservabilityEvents({
      companyId: 'c1',
      search: 'wake-skipped',
      pageSize: 10,
    });
    const id = rows.events[0]!.id;
    const row = await observability.getObservabilityEvent('c1', id);
    assert.ok(row);
    assert.equal(row!.heartbeatRunStatus, 'skipped');
  });
});

// M5 compile-time pin (checked by `pnpm -r type-check`, not at tsx runtime):
// the row union in observability-types.ts must admit 'skipped'.
const _skippedUnionPin: import('./observability-types').ObservabilityEventRow['heartbeatRunStatus'] =
  'skipped';
void _skippedUnionPin;
