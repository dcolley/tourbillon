import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  ORPHANED_ON_RESTART_ERROR_TEXT,
  reconcileChatTaskRunsOnStartup,
  sweepOrphanedRunsOnStartup,
} from './startup-sweep';
import { fakeReconcileDb, staleRow } from './__fixtures__/fake-reconcile-db';

process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused';

function fakeDb(returned: Array<{ id: string }>) {
  const captured: { set?: Record<string, unknown>; where?: SQL } = {};
  const db = {
    update: () => ({
      set: (v: Record<string, unknown>) => {
        captured.set = v;
        return {
          where: (w: SQL) => {
            captured.where = w;
            return { returning: async () => returned };
          },
        };
      },
    }),
  };
  return { db: db as never, captured };
}

describe('sweepOrphanedRunsOnStartup', () => {
  it("marks 'running' rows not seen since boot (or never seen) as failed, returns the count", async () => {
    const boot = new Date('2026-10-16T18:00:00Z');
    const { db, captured } = fakeDb([{ id: 'r1' }, { id: 'r2' }]);
    const n = await sweepOrphanedRunsOnStartup(boot, db);
    assert.equal(n, 2);
    assert.equal(captured.set?.status, 'failed');
    assert.equal(captured.set?.errorText, ORPHANED_ON_RESTART_ERROR_TEXT);
    assert.ok(captured.set?.finishedAt instanceof Date);
    const q = new PgDialect().sqlToQuery(captured.where!);
    assert.match(q.sql, /"status" = \$1/);
    assert.match(q.sql, /"last_seen_at" is null or "heartbeat_runs"\."last_seen_at" < \$2/);
    assert.equal(q.params[0], 'running');
    assert.equal(String(q.params[1]), boot.toISOString());
  });

  it('returns 0 when nothing was orphaned', async () => {
    const { db } = fakeDb([]);
    assert.equal(await sweepOrphanedRunsOnStartup(new Date(), db), 0);
  });
});

// S1 (#202 ACCEPT softs): the boot reconcile's company-budget WIRING. The db package's own
// reconcile tests hand `resolveMaxAttempts` their own inline copy, so they stay green even if
// startup-sweep.ts drops the resolver from its reconcileStaleChatTaskRuns call (budget then
// silently reverts to the fixed default 2: budget-1 companies re-queue past their limit on
// every boot). These tests drive the REAL production call site, so they fail when the wiring
// is dropped or swapped for a non-clamping copy.
describe('reconcileChatTaskRunsOnStartup: resolveMaxAttempts is wired to the company budget (S1, #202 softs)', () => {
  it("company maxAttemptsPerTask=1: an attempts=1 lost run PARKS (dropping resolveMaxAttempts would re-queue it)", async () => {
    const { db, settled } = fakeReconcileDb({
      stale: [staleRow({ taskId: 't-single', attempts: 1, companySettings: { taskRunner: { maxAttemptsPerTask: 1 } } })],
    });
    const result = await reconcileChatTaskRunsOnStartup(new Date('2026-10-28T12:00:00Z'), db);
    assert.deepEqual({ requeued: result.requeued, parked: result.parked }, { requeued: 0, parked: 1 });
    assert.equal(settled[0]?.status, 'waiting_on_user');
    assert.match(settled[0]?.notes ?? '', /attempt budget exhausted/);
  });

  it('company settings unset: default budget 2 still re-queues an attempts=1 lost run', async () => {
    const { db, settled } = fakeReconcileDb({ stale: [staleRow({ taskId: 't-def', attempts: 1 })] });
    const result = await reconcileChatTaskRunsOnStartup(new Date('2026-10-28T12:00:00Z'), db);
    assert.deepEqual({ requeued: result.requeued, parked: result.parked }, { requeued: 1, parked: 0 });
    assert.equal(settled[0]?.status, 'pending');
  });

  it('the resolver is the REAL one (clamped): maxAttemptsPerTask=99 clamps to 5, so attempts=5 parks', async () => {
    // A naive non-clamping copy (`Number(raw)`) would see 99 and re-queue forever.
    const { db, settled } = fakeReconcileDb({
      stale: [staleRow({ taskId: 't-clamp', attempts: 5, companySettings: { taskRunner: { maxAttemptsPerTask: 99 } } })],
    });
    const result = await reconcileChatTaskRunsOnStartup(new Date('2026-10-28T12:00:00Z'), db);
    assert.deepEqual({ requeued: result.requeued, parked: result.parked }, { requeued: 0, parked: 1 });
    assert.equal(settled[0]?.status, 'waiting_on_user');
  });
});
