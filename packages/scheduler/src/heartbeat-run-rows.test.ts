/**
 * Run-row writes that must not race with a board 'Archive agent':
 * - insertHeartbeatRunUnlessArchived: the wake's run insert re-checks the agent under a row lock.
 * - markHeartbeatRunSucceeded: only a still-running row becomes succeeded.
 * The real drizzle query builder (pg-proxy driver) runs against a tiny in-memory Postgres stand-in
 * that evaluates these statements and models the agent row lock (FOR UPDATE waits for the holder).
 * All values are fakes.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { insertHeartbeatRunUnlessArchived, markHeartbeatRunSucceeded } from './heartbeat-run-rows';

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let agentRow: { id: string; companyId: string; status: string } | null;
let runs: Array<{ id: string; status: string }>;
let statements: Array<{ sql: string; params: unknown[] }>;
/** Held by the "archive transaction" while it updates the agent row (FOR UPDATE waits on it). */
let agentRowLock: Promise<void>;
/** Resolves once a FOR UPDATE is waiting on the lock. */
let lockWaiter: Deferred;

const proxy = drizzle(async (sql: string, params: unknown[]) => {
  statements.push({ sql, params });
  if (sql.startsWith('select') && sql.endsWith('for update')) {
    lockWaiter.resolve();
    await agentRowLock;
    const [id, companyId] = params;
    const hit = agentRow && agentRow.id === id && agentRow.companyId === companyId;
    return { rows: hit ? [[agentRow!.status]] : [] };
  }
  if (sql.startsWith('insert into "heartbeat_runs"')) {
    runs.push({ id: String(params[0]), status: 'running' });
    return { rows: [] };
  }
  if (sql.startsWith('update "heartbeat_runs"')) {
    const status = params[0];
    const [id, whereStatus] = params.slice(-2);
    const hit = runs.filter((r) => r.id === id && r.status === whereStatus);
    hit.forEach((r) => {
      r.status = String(status);
    });
    return { rows: hit.map((r) => [r.id]) };
  }
  throw new Error(`unexpected statement: ${sql}`);
});
/** The helper only needs db.transaction; the stand-in runs the callback on the same connection. */
const db = { transaction: async (fn: (tx: typeof proxy) => Promise<unknown>) => fn(proxy) } as never;

const RUN = {
  id: 'run-new',
  agentId: 'agent-1',
  companyId: 'company-1',
  invocationSource: 'timer',
  status: 'running' as const,
};

describe('insertHeartbeatRunUnlessArchived (wake start vs archive)', () => {
  beforeEach(() => {
    agentRow = { id: 'agent-1', companyId: 'company-1', status: 'active' };
    runs = [];
    statements = [];
    agentRowLock = Promise.resolve();
    lockWaiter = deferred();
  });

  it('locks the agent row (company-scoped) before inserting, then inserts the run', async () => {
    assert.equal(await insertHeartbeatRunUnlessArchived(db, RUN as never), true);
    assert.deepEqual(runs.map((r) => r.id), ['run-new']);
    assert.equal(statements.length, 2);
    assert.match(statements[0].sql, /^select "status" from "agents" where \("agents"\."id" = \$1 and "agents"\."company_id" = \$2\) for update$/);
    assert.deepEqual(statements[0].params, ['agent-1', 'company-1']);
    assert.match(statements[1].sql, /^insert into "heartbeat_runs"/);
  });

  it('archived agent: refused (false), no run row', async () => {
    agentRow!.status = 'archived';
    assert.equal(await insertHeartbeatRunUnlessArchived(db, RUN as never), false);
    assert.deepEqual(runs, []);
    assert.equal(statements.filter((s) => s.sql.startsWith('insert')).length, 0);
  });

  it("agent missing or in another company: refused, no run row", async () => {
    agentRow = { id: 'agent-1', companyId: 'company-2', status: 'active' };
    assert.equal(await insertHeartbeatRunUnlessArchived(db, RUN as never), false);
    agentRow = null;
    assert.equal(await insertHeartbeatRunUnlessArchived(db, RUN as never), false);
    assert.deepEqual(runs, []);
  });

  it('race: archive holds the agent row when the wake inserts → the wake waits, then sees archived and creates nothing', async () => {
    const archiveTx = deferred();
    agentRowLock = archiveTx.promise;
    // The wake already passed its early 'active' check; now it tries to create the run.
    const wake = insertHeartbeatRunUnlessArchived(db, RUN as never);
    await lockWaiter.promise; // the wake is blocked on the agent row
    agentRow!.status = 'archived'; // the archive's update...
    archiveTx.resolve(); // ...commits and releases the row
    assert.equal(await wake, false);
    assert.deepEqual(runs, []);
  });

  it('race: the wake locks the row first → its run is committed before the archive can write (the archive then stops it)', async () => {
    assert.equal(await insertHeartbeatRunUnlessArchived(db, RUN as never), true);
    agentRow!.status = 'archived'; // archive runs after; it finds run-new in flight and kills it
    assert.deepEqual(runs, [{ id: 'run-new', status: 'running' }]);
  });
});

describe('markHeartbeatRunSucceeded (late success vs kill)', () => {
  beforeEach(() => {
    runs = [{ id: 'run-1', status: 'running' }];
    statements = [];
  });
  const success = () => ({ status: 'succeeded' as const, finishedAt: new Date(), errorText: null });

  it('a running row becomes succeeded; the status guard is part of the update itself', async () => {
    assert.equal(await markHeartbeatRunSucceeded(proxy as never, 'run-1', success()), true);
    assert.equal(runs[0].status, 'succeeded');
    assert.equal(statements.length, 1, 'one statement: no separate read before the write');
    assert.match(statements[0].sql, /where \("heartbeat_runs"\."id" = \$\d+ and "heartbeat_runs"\."status" = \$\d+\)/);
    assert.deepEqual(statements[0].params.slice(-2), ['run-1', 'running']);
  });

  for (const terminal of ['cancelled', 'failed', 'succeeded']) {
    it(`a run already ${terminal} (archive kill / operator kill / done) keeps its status → false`, async () => {
      runs[0].status = terminal;
      assert.equal(await markHeartbeatRunSucceeded(proxy as never, 'run-1', success()), false);
      assert.equal(runs[0].status, terminal);
    });
  }

  it('race: the archive kill lands after the work finished but before the success write → stays cancelled', async () => {
    // Work done; the kill is recorded; then the success write runs.
    runs[0].status = 'cancelled';
    assert.equal(await markHeartbeatRunSucceeded(proxy as never, 'run-1', { ...success(), traceId: 't-1' }), false);
    assert.equal(runs[0].status, 'cancelled');
  });
});
