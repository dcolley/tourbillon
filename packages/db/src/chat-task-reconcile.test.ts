/**
 * S2 (#196 follow-up) unit tests: reconciling crashed/stale Run Task rows against an
 * in-memory Postgres (PGlite), with the repo's own migrations applied.
 *
 * The failure being fixed: the scheduler dies mid-Run-Task, the startup sweep fails the
 * heartbeat_runs row, but nothing ever calls finishChatTaskRun — the chat_tasks row is
 * stuck `in_progress` forever. The reconciler settles exactly the runner-owned rows whose
 * linked run is terminal / missing / stale (mirroring the heartbeat sweep's liveness rule),
 * re-queueing to `pending` while the attempt budget lasts, parking to `waiting_on_user`
 * once it is spent. Human-set in_progress rows and fresh claims are never touched.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import * as schema from './schema/index';
import {
  addChatTask,
  claimChatTaskRun,
  listChatTasks,
  listStaleChatTaskRuns,
  reconcileStaleChatTaskRuns,
  setChatTaskStatus,
} from './chat-task-queries';

const MIGRATIONS = path.join(__dirname, 'migrations');
const JOURNAL = (
  JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string; when: number }[];
  }
).entries;
const WHEN_LATEST = JOURNAL[JOURNAL.length - 1]!.when;

/** Apply every migration in the journal (same rule as drizzle's migrator). */
async function migrateUp(client: PGlite): Promise<void> {
  await client.exec(`
    create schema if not exists drizzle;
    create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
  `);
  for (const m of readMigrationFiles({ migrationsFolder: MIGRATIONS })) {
    if (m.folderMillis > WHEN_LATEST) break;
    for (const chunk of m.sql) {
      if (chunk.trim()) await client.exec(chunk);
    }
    await client.query('insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)', [
      m.hash,
      m.folderMillis,
    ]);
  }
}

/** Fresh in-memory db with the schema migrated and one company / two agents seeded. */
async function freshDb() {
  const client = new PGlite();
  await migrateUp(client);
  const db = drizzle(client, { schema });
  await client.exec(`
    insert into companies (id, name, slug, issue_prefix) values ('c1', 'Bug Hunt', 'bug-hunt', 'BH');
    insert into agents (id, company_id, name, role, title, url_key) values
      ('a1', 'c1', 'Assistant', 'cto', 'The Assistant', 'assistant'),
      ('a2', 'c1', 'Other Agent', 'engineer', 'Engineer', 'other-agent');
  `);
  return { client, db };
}

const A1 = { companyId: 'c1', agentId: 'a1' };

/** Seed the linked heartbeat_runs row exactly as the Run Task wake would insert it. */
async function seedRun(
  client: PGlite,
  run: { id: string; status: string; lastSeenAt: Date | null; agentId?: string },
): Promise<void> {
  await client.query(
    `insert into heartbeat_runs (id, company_id, agent_id, invocation_source, status, started_at, last_seen_at)
     values ($1, 'c1', $2, 'task', $3, now(), $4)`,
    [run.id, run.agentId ?? 'a1', run.status, run.lastSeenAt],
  );
}

/** Age a claimed row's updated_at so it sits past the sweep cutoff (as an old crash would). */
async function ageClaim(client: PGlite, taskId: string, hoursAgo = 1): Promise<void> {
  await client.query(`update chat_tasks set updated_at = now() - interval '1 hour' * $2 where id = $1`, [
    taskId,
    hoursAgo,
  ]);
}

/** Claim a task and age the claim — the shape of a Run Task whose worker died. */
async function claimedCrash(
  client: PGlite,
  db: Parameters<typeof claimChatTaskRun>[0],
  taskId: string,
  runId: string,
) {
  const claimed = await claimChatTaskRun(db, { taskId, runId });
  assert.ok(claimed, `claim ${taskId} must succeed`);
  await ageClaim(client, taskId);
  return claimed;
}

/** The sweep passes now - HEARTBEAT_STALE_SEC (90 s default); tests use that shape. */
const sweepCutoff = () => new Date(Date.now() - 90_000);

describe('reconcileStaleChatTaskRuns (S2: crashed/stale Run Task rows)', () => {
  it("re-queues an in_progress row whose run row is FAILED, with attempts left, appending a note", async () => {
    const { client, db } = await freshDb();
    try {
      const task = await addChatTask(A1, { title: 'Ship the runbook', notes: 'Notify: Ops' }, db);
      await claimedCrash(client, db, task.id, 'run-dead');
      await seedRun(client, { id: 'run-dead', status: 'failed', lastSeenAt: new Date(Date.now() - 2 * 3600_000) });

      const result = await reconcileStaleChatTaskRuns(db, { staleCutoff: sweepCutoff() });
      assert.deepEqual(
        { requeued: result.requeued, parked: result.parked },
        { requeued: 1, parked: 0 },
      );
      assert.deepEqual(result.reconciled.map((r) => r.taskId), [task.id]);

      const [row] = await listChatTasks(A1, { includeClosed: true }, db);
      assert.equal(row!.status, 'pending', 're-queued for a fresh attempt');
      assert.equal(row!.completedAt, null);
      assert.equal(row!.runnerLastRunId, 'run-dead', 'audit link is kept, not cleared');
      assert.equal(row!.runnerAttempts, 1, 'attempts are NOT refunded — the re-queue is the budget');
      assert.match(row!.notes!, /^Notify: Ops\n\[runner\] Run Task lost/, 'note appended to the existing notes');
      // The re-queued row is claimable again (the poller's retry path is live).
      const reclaimed = await claimChatTaskRun(db, { taskId: task.id, runId: 'run-retry' });
      assert.equal(reclaimed?.runnerAttempts, 2);
    } finally {
      await client.close();
    }
  });

  it('parks to waiting_on_user when the attempt budget is exhausted', async () => {
    const { client, db } = await freshDb();
    try {
      const task = await addChatTask(A1, { title: 'Flaky thing' }, db);
      assert.ok(await claimChatTaskRun(db, { taskId: task.id, runId: 'run-a' }));
      // Burn the second attempt the way the retry path does: settle, then claim again.
      await client.query(`update chat_tasks set status = 'pending' where id = $1`, [task.id]);
      assert.ok(await claimChatTaskRun(db, { taskId: task.id, runId: 'run-b' }));
      await seedRun(client, { id: 'run-b', status: 'failed', lastSeenAt: null });
      await ageClaim(client, task.id);

      const result = await reconcileStaleChatTaskRuns(db, { staleCutoff: sweepCutoff(), maxAttempts: 2 });
      assert.deepEqual({ requeued: result.requeued, parked: result.parked }, { requeued: 0, parked: 1 });
      const [row] = await listChatTasks(A1, { includeClosed: true }, db);
      assert.equal(row!.status, 'waiting_on_user');
      assert.match(row!.notes!, /attempt budget exhausted/);
    } finally {
      await client.close();
    }
  });

  it("leaves rows whose run is LIVE alone — fresh running, queued, and null-last_seen_at rows all count as live", async () => {
    const { client, db } = await freshDb();
    try {
      const running = await addChatTask(A1, { title: 'Really running' }, db);
      await claimedCrash(client, db, running.id, 'run-live');
      await seedRun(client, { id: 'run-live', status: 'running', lastSeenAt: new Date() });

      const queued = await addChatTask(A1, { title: 'Queued run' }, db);
      await claimedCrash(client, db, queued.id, 'run-queued');
      await seedRun(client, { id: 'run-queued', status: 'queued', lastSeenAt: new Date() });

      // Mirrors countActiveRuns' fresh-or-null rule: a running row that never pinged is live.
      const neverPinged = await addChatTask(A1, { title: 'Never pinged' }, db);
      await claimedCrash(client, db, neverPinged.id, 'run-null');
      await seedRun(client, { id: 'run-null', status: 'running', lastSeenAt: null });

      const result = await reconcileStaleChatTaskRuns(db, { staleCutoff: sweepCutoff() });
      assert.deepEqual({ requeued: result.requeued, parked: result.parked }, { requeued: 0, parked: 0 });
      const statuses = Object.fromEntries(
        (await listChatTasks(A1, {}, db)).map((t) => [t.title, t.status]),
      );
      assert.deepEqual(statuses, {
        'Really running': 'in_progress',
        'Queued run': 'in_progress',
        'Never pinged': 'in_progress',
      });
    } finally {
      await client.close();
    }
  });

  it("re-queues a row whose running run went STALE (last_seen_at older than the cutoff)", async () => {
    const { client, db } = await freshDb();
    try {
      const task = await addChatTask(A1, { title: 'Zombie worker' }, db);
      await claimedCrash(client, db, task.id, 'run-zombie');
      // status still 'running' but the worker stopped pinging before the sweep cutoff.
      await seedRun(client, { id: 'run-zombie', status: 'running', lastSeenAt: new Date(Date.now() - 2 * 3600_000) });

      const result = await reconcileStaleChatTaskRuns(db, { staleCutoff: sweepCutoff() });
      assert.deepEqual({ requeued: result.requeued, parked: result.parked }, { requeued: 1, parked: 0 });
      const [row] = await listChatTasks(A1, { includeClosed: true }, db);
      assert.equal(row!.status, 'pending');
    } finally {
      await client.close();
    }
  });

  it('re-queues a MISSING run row only after the claim grace — a fresh claim is never raced', async () => {
    const { client, db } = await freshDb();
    try {
      // Crash between claim and heartbeat_runs insert: no run row exists at all.
      const old = await addChatTask(A1, { title: 'Claimed then vanished' }, db);
      const claimed = await claimChatTaskRun(db, { taskId: old.id, runId: 'run-gone' });
      assert.ok(claimed);
      await ageClaim(client, old.id);

      // Fresh claim made seconds ago whose insert has not landed yet — must be left alone.
      const fresh = await addChatTask(A1, { title: 'Just claimed' }, db);
      assert.ok(await claimChatTaskRun(db, { taskId: fresh.id, runId: 'run-fresh' }));

      const result = await reconcileStaleChatTaskRuns(db, { staleCutoff: sweepCutoff() });
      assert.deepEqual(result.reconciled.map((r) => r.taskId), [old.id]);
      assert.equal((await listChatTasks(A1, {}, db)).find((t) => t.id === fresh.id)?.status, 'in_progress');
      assert.equal((await listChatTasks(A1, { includeClosed: true }, db)).find((t) => t.id === old.id)?.status, 'pending');
    } finally {
      await client.close();
    }
  });

  it('never touches human-set in_progress rows, cancelled/done rows, or other agents rows', async () => {
    const { client, db } = await freshDb();
    try {
      // Human set it in_progress via the chat tool (no runner claim → no run id, 0 attempts).
      const manual = await addChatTask(A1, { title: 'Human owns this' }, db);
      await setChatTaskStatus(A1, { id: manual.id, status: 'in_progress' }, db);
      await ageClaim(client, manual.id);

      // Claimed but cancelled by the human while running (finish's guard must keep it dead).
      const cancelled = await addChatTask(A1, { title: 'Cancelled mid-run' }, db);
      await claimedCrash(client, db, cancelled.id, 'run-cancelled');
      await seedRun(client, { id: 'run-cancelled', status: 'failed', lastSeenAt: null });
      await setChatTaskStatus(A1, { id: cancelled.id, status: 'cancelled' }, db);

      // Another agent's crashed run IS in scope (per row, not per agent) — control row.
      const theirs = await addChatTask({ companyId: 'c1', agentId: 'a2' }, { title: 'Theirs crashed' }, db);
      const claimedTheirs = await claimChatTaskRun(db, { taskId: theirs.id, runId: 'run-theirs' });
      assert.ok(claimedTheirs);
      await ageClaim(client, theirs.id);

      const stale = await listStaleChatTaskRuns(db, { staleCutoff: sweepCutoff() });
      assert.deepEqual(stale.map((r) => r.taskId), [theirs.id], 'only the runner-owned dead row is listed');

      const result = await reconcileStaleChatTaskRuns(db, { staleCutoff: sweepCutoff() });
      assert.deepEqual({ requeued: result.requeued, parked: result.parked }, { requeued: 1, parked: 0 });
      assert.equal((await listChatTasks(A1, { includeClosed: true }, db)).find((t) => t.id === manual.id)?.status, 'in_progress');
      assert.equal((await listChatTasks(A1, { includeClosed: true }, db)).find((t) => t.id === cancelled.id)?.status, 'cancelled');
    } finally {
      await client.close();
    }
  });

  it('is idempotent and honours the limit; a normally-settled row is left alone', async () => {
    const { client, db } = await freshDb();
    try {
      const a = await addChatTask(A1, { title: 'A' }, db);
      const b = await addChatTask(A1, { title: 'B' }, db);
      await claimedCrash(client, db, a.id, 'run-a');
      await claimedCrash(client, db, b.id, 'run-b');
      await seedRun(client, { id: 'run-a', status: 'failed', lastSeenAt: null });
      await seedRun(client, { id: 'run-b', status: 'succeeded', lastSeenAt: null });

      // Normal settle lands between sweeps (run finished fine, the loop died before noting):
      // finish settles it — the reconciler must skip it afterwards.
      const { finishChatTaskRun } = await import('./chat-task-queries');
      assert.ok(await finishChatTaskRun(db, { taskId: b.id, status: 'done' }));

      const first = await reconcileStaleChatTaskRuns(db, { staleCutoff: sweepCutoff(), limit: 1 });
      assert.equal(first.requeued, 1);
      const second = await reconcileStaleChatTaskRuns(db, { staleCutoff: sweepCutoff(), limit: 1 });
      assert.deepEqual({ requeued: second.requeued, parked: second.parked }, { requeued: 0, parked: 0 }, 'nothing left to settle');
      const statuses = Object.fromEntries(
        (await listChatTasks(A1, { includeClosed: true }, db)).map((t) => [t.title, t.status]),
      );
      assert.deepEqual(statuses, { A: 'pending', B: 'done' });
    } finally {
      await client.close();
    }
  });
});
