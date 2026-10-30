/**
 * S263-S3 (#263 softs): the stale-run sweep's audit write is best-effort but NEVER silent —
 * `reconcileStaleChatTaskRuns` gains an `onAuditError` sink so a broken activity_log insert is
 * heard by the caller (the scheduler sweep wires it to its logger; the db layer just surfaces it).
 *
 * Pins, against PGlite with the repo's own migrations:
 *  - audit:true + a throwing insert → reconcileStaleChatTaskRuns still settles every lost run
 *    (re-queue AND park counts unchanged, chat_tasks rows actually move);
 *  - the sink is called once per lost row with the underlying error and the stale row;
 *  - no audit rows land, and the reconcile never throws.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import * as schema from './schema/index';
import { activityLog } from './schema/activity-log';
import {
  addChatTask,
  claimChatTaskRun,
  reconcileStaleChatTaskRuns,
  listChatTasks,
  type ChatTaskDb,
} from './chat-task-queries';

const MIGRATIONS = path.join(__dirname, 'migrations');

async function freshDb() {
  const client = new PGlite();
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
  const db = drizzle(client, { schema });
  await client.exec(`
    insert into companies (id, name, slug, issue_prefix) values ('c1', 'Bug Hunt', 'bug-hunt', 'BH');
    insert into agents (id, company_id, name, role, title, url_key) values ('a1', 'c1', 'Assistant', 'cto', 'The Assistant', 'assistant');
  `);
  return { client, db };
}

const A1 = { companyId: 'c1', agentId: 'a1' };

/** Claim a task, age the claim, and give it a dead run row — the crashed-Run Task shape. */
async function crashedRun(
  client: PGlite,
  db: ChatTaskDb,
  over: { taskId: string; title: string; runId: string; attempts: number },
) {
  const task = await addChatTask(A1, { title: over.title }, db);
  const claimed = await claimChatTaskRun(db, { taskId: task.id, runId: over.runId });
  assert.ok(claimed, `claim ${over.taskId} must succeed`);
  if (over.attempts > 1) {
    await client.query(`update chat_tasks set runner_attempts = $2 where id = $1`, [task.id, over.attempts]);
  }
  await client.query(
    `insert into heartbeat_runs (id, company_id, agent_id, invocation_source, status, started_at, last_seen_at)
     values ($1, 'c1', 'a1', 'task', 'failed', now() - interval '2 hours', now() - interval '2 hours')`,
    [over.runId],
  );
  await client.query(`update chat_tasks set updated_at = now() - interval '1 hour' where id = $1`, [task.id]);
  return task;
}

describe('reconcileStaleChatTaskRuns onAuditError (S263-S3, #263 softs)', () => {
  it('a throwing audit insert is surfaced to onAuditError per settled row and never blocks the settle', async () => {
    const { client, db } = await freshDb();
    try {
      const requeueTask = await crashedRun(client, db, { taskId: 't-lost', title: 'Lost run', runId: 'run-dead-1', attempts: 1 });
      const parkTask = await crashedRun(client, db, { taskId: 't-dead', title: 'Dead run', runId: 'run-dead-2', attempts: 2 });

      // Break ONLY the activity insert (same seam the tool-side test uses); queue writes live.
      const broken = Object.create(db, {
        insert: {
          value: (table: unknown) => {
            if (table === activityLog) throw new Error('activity db down');
            return (db as never as { insert: (t: unknown) => never }).insert(table);
          },
        },
      }) as ChatTaskDb;

      const failures: Array<{ message: string; taskId: string; companyId: string }> = [];
      const result = await reconcileStaleChatTaskRuns(broken, {
        staleCutoff: new Date(Date.now() - 90_000),
        audit: true,
        onAuditError: (err, row) =>
          failures.push({
            message: err instanceof Error ? err.message : String(err),
            taskId: row.taskId,
            companyId: row.companyId,
          }),
      });

      assert.equal(result.requeued, 1, 'the re-queue still settles despite the audit outage');
      assert.equal(result.parked, 1, '…and so does the park');
      assert.deepEqual(failures.map((f) => f.message).sort(), ['activity db down', 'activity db down']);
      assert.deepEqual(
        failures.map((f) => f.taskId).sort(),
        [requeueTask.id, parkTask.id].sort(),
        'one failure per lost row, carrying the stale row for triage',
      );
      assert.ok(failures.every((f) => f.companyId === 'c1'));

      // The stored transitions really happened — best-effort audit, durable queue.
      const rows = await listChatTasks(A1, { includeClosed: true }, db);
      assert.equal(rows.find((r) => r.id === requeueTask.id)?.status, 'pending');
      assert.equal(rows.find((r) => r.id === parkTask.id)?.status, 'waiting_on_user');
      const landed = await client.query<{ count: string }>(`select count(*)::text as count from activity_log`);
      assert.equal(landed.rows[0]!.count, '0', 'no audit rows landed — and that is now a LOUD failure, not silence');
    } finally {
      await client.close();
    }
  });

  it('without onAuditError the swallow contract is unchanged (reconcile never throws, no sink)', async () => {
    const { client, db } = await freshDb();
    try {
      await crashedRun(client, db, { taskId: 't-lost', title: 'Lost run', runId: 'run-dead-1', attempts: 1 });
      const broken = Object.create(db, {
        insert: {
          value: (table: unknown) => {
            if (table === activityLog) throw new Error('activity db down');
            return (db as never as { insert: (t: unknown) => never }).insert(table);
          },
        },
      }) as ChatTaskDb;
      const result = await reconcileStaleChatTaskRuns(broken, { staleCutoff: new Date(Date.now() - 90_000), audit: true });
      assert.equal(result.requeued, 1);
    } finally {
      await client.close();
    }
  });
});
