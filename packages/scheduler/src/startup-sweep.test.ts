import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { ORPHANED_ON_RESTART_ERROR_TEXT, sweepOrphanedRunsOnStartup } from './startup-sweep';

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
