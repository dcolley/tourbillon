/**
 * S295-S3 / S298-S1 (#295, #298): observability rows must surface every terminal
 * heartbeat run status via `heartbeatRunStatus`.
 *
 * `heartbeatRunStatusForRow` in lib/observability.ts originally whitelisted only
 * running/succeeded/failed: #295 added `skipped`, and S298-S1 (#298) added
 * `coalesced` and `cancelled` so every terminal HeartbeatStatus maps through — an
 * event linked to a terminal run never shows a null run status. Pinned against
 * PGlite (real migrations, real loader): one event per linked run status, plus an
 * orphan event (no linked run → null).
 *
 * Mutants (S298-S1 gate): drop `run.status === 'coalesced'` (or 'cancelled') from
 * the whitelist → that row maps to null → RED. Legacy M4 (S295-S3): drop 'skipped'
 * → RED. M5-style compile-time union pins at the bottom of this file turn removing
 * a literal from ObservabilityEventRow['heartbeatRunStatus'] RED for
 * `pnpm -r type-check` (tsx strips types at test time).
 *
 * S298-S2 (#298) note: `heartbeatRunStatus` is API/MCP-visible only — no apps/web
 * UI renders it (documented on the field itself); rendering it is a separate story.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { TERMINAL_HEARTBEAT_STATUSES } from '@tourbillon/shared/terminal-heartbeat-statuses';

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
      ('r-running',   'c1', 'a1', 'assignment', 'running',   null),
      ('r-succeeded', 'c1', 'a1', 'assignment', 'succeeded', null),
      ('r-failed',    'c1', 'a1', 'assignment', 'failed',    'boom'),
      ('r-skipped',   'c1', 'a1', 'assignment', 'skipped',   'Task issue-9 is assigned to agent other, not a1'),
      ('r-coalesced', 'c1', 'a1', 'timer',      'coalesced', 'coalesced into a newer wake'),
      ('r-cancelled', 'c1', 'a1', 'on_demand',  'cancelled', 'operator force-killed the wake');
    insert into agent_observability_events
      (id, company_id, trace_id, span_id, event_type, name, status, heartbeat_run_id, occurred_at) values
      ('e-1', 'c1', 'tr-run', 'sp-1', 'agent_run', 'wake-running',   'ok', 'r-running',   '2026-11-01T00:01:00Z'),
      ('e-2', 'c1', 'tr-run', 'sp-2', 'agent_run', 'wake-ok',        'ok', 'r-succeeded', '2026-11-01T00:02:00Z'),
      ('e-3', 'c1', 'tr-run', 'sp-3', 'agent_run', 'wake-failed',    'ok', 'r-failed',    '2026-11-01T00:03:00Z'),
      ('e-4', 'c1', 'tr-run', 'sp-4', 'agent_run', 'wake-skipped',   'ok', 'r-skipped',   '2026-11-01T00:04:00Z'),
      ('e-5', 'c1', 'tr-run', 'sp-5', 'agent_run', 'wake-coalesced', 'ok', 'r-coalesced', '2026-11-01T00:05:00Z'),
      ('e-7', 'c1', 'tr-run', 'sp-7', 'agent_run', 'wake-cancelled', 'ok', 'r-cancelled', '2026-11-01T00:07:00Z'),
      ('e-6', 'c1', 'tr-run', 'sp-6', 'agent_run', 'wake-orphan',    'ok', null,          '2026-11-01T00:06:00Z');
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
// into the imported module on FIRST load, so re-importing with a second seeded
// client would silently keep querying the closed first one.
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

describe('observability heartbeatRunStatus: every terminal run status maps through (S295-S3 + S298-S1)', () => {
  it('listObservabilityEvents exposes running + every terminal status; orphan stays null', async () => {
    const { observability } = await sharedObservability();
    const result = await observability.listObservabilityEvents({
      companyId: 'c1',
      pageSize: 50,
    });
    const byName = new Map(result.events.map((e) => [e.name, e]));
    assert.equal(result.total, 7);

    assert.equal(byName.get('wake-running')!.heartbeatRunStatus, 'running');
    assert.equal(byName.get('wake-ok')!.heartbeatRunStatus, 'succeeded');
    assert.equal(byName.get('wake-failed')!.heartbeatRunStatus, 'failed');

    // Per-terminal-status pins (S298-S1): skipped, coalesced and cancelled all map —
    // dropping any whitelist line in heartbeatRunStatusForRow goes RED.
    for (const status of TERMINAL_HEARTBEAT_STATUSES) {
      const row = byName.get(`wake-${status === 'succeeded' ? 'ok' : status}`);
      assert.ok(row, `seed event for '${status}' must exist`);
      assert.equal(row!.heartbeatRunStatus, status, `'${status}' must map through, not null`);
    }

    const skipped = byName.get('wake-skipped');
    assert.ok(
      skipped!.heartbeatRunErrorText?.includes('assigned to agent'),
      'the skip reason must ride along for triage',
    );
    assert.ok(byName.get('wake-coalesced')!.heartbeatRunErrorText?.includes('coalesced'));
    assert.ok(byName.get('wake-cancelled')!.heartbeatRunErrorText?.includes('force-killed'));

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

// M5-style compile-time pins (checked by `pnpm -r type-check`, not at tsx runtime):
// the row union in observability-types.ts must admit every terminal status literal.
const _skippedUnionPin: import('./observability-types').ObservabilityEventRow['heartbeatRunStatus'] =
  'skipped';
const _coalescedUnionPin: import('./observability-types').ObservabilityEventRow['heartbeatRunStatus'] =
  'coalesced';
const _cancelledUnionPin: import('./observability-types').ObservabilityEventRow['heartbeatRunStatus'] =
  'cancelled';
void _skippedUnionPin;
void _coalescedUnionPin;
void _cancelledUnionPin;
