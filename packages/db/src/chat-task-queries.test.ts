/**
 * TASK-1 unit tests: the chat-task query layer against an in-memory Postgres (PGlite),
 * with the repo's own migrations applied. No external database is touched.
 *
 * The binding behaviours: one private list per (company, agent) — agent A can never read or
 * mutate agent B's rows, one company never sees another's — and the list is keyed by that
 * (company, agent) scope, NOT the Mastra thread, so Clear chat (a new thread) keeps the list.
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
  countOpenChatTasks,
  listChatTasks,
  setChatTaskStatus,
  updateChatTask,
} from './chat-task-queries';

const MIGRATIONS = path.join(__dirname, 'migrations');
const WHEN_0023 = (
  JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string; when: number }[];
  }
).entries.find((e) => e.tag === '0023_chat_tasks')!.when;

/** Apply every migration through 0023 (same rule as drizzle's migrator). */
async function migrateUp(client: PGlite): Promise<void> {
  await client.exec(`
    create schema if not exists drizzle;
    create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
  `);
  for (const m of readMigrationFiles({ migrationsFolder: MIGRATIONS })) {
    if (m.folderMillis > WHEN_0023) break;
    for (const chunk of m.sql) {
      if (chunk.trim()) await client.exec(chunk);
    }
    await client.query('insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)', [
      m.hash,
      m.folderMillis,
    ]);
  }
}

/** Fresh in-memory db with the schema migrated and two companies / three agents seeded. */
async function freshDb() {
  const client = new PGlite();
  await migrateUp(client);
  const db = drizzle(client, { schema });
  await client.exec(`
    insert into companies (id, name, slug, issue_prefix) values ('c1', 'Bug Hunt', 'bug-hunt', 'BH'), ('c2', 'Other Co', 'other', 'OC');
    insert into agents (id, company_id, name, role, title, url_key) values
      ('a1', 'c1', 'Assistant', 'cto', 'The Assistant', 'assistant'),
      ('a2', 'c1', 'Other Agent', 'engineer', 'Engineer', 'other-agent'),
      ('b1', 'c2', 'Foreign Agent', 'engineer', 'Engineer', 'foreign-agent');
  `);
  return { client, db };
}

const A1 = { companyId: 'c1', agentId: 'a1' };
const A2 = { companyId: 'c1', agentId: 'a2' };
const B1 = { companyId: 'c2', agentId: 'b1' };

describe('chat-task query layer', () => {
  it('adds to the tail (position), lists open items, and round-trips every status', async () => {
    const { client, db } = await freshDb();
    try {
      const first = await addChatTask(A1, { title: 'Draft the runbook' }, db);
      const second = await addChatTask(A1, { title: 'Check the restore backup', sourceThreadId: 'thread-1' }, db);
      assert.equal(first.position, 0);
      assert.equal(second.position, 1);
      assert.equal(first.status, 'pending');

      let listed = await listChatTasks(A1, {}, db);
      assert.deepEqual(listed.map((t) => t.title), ['Draft the runbook', 'Check the restore backup']);

      // Every status round-trips; done/cancelled are hidden by default and shown with includeClosed.
      assert(await setChatTaskStatus(A1, { id: first.id, status: 'in_progress' }, db));
      assert(await setChatTaskStatus(A1, { id: second.id, status: 'waiting_on_user' }, db));
      listed = await listChatTasks(A1, {}, db);
      assert.equal(listed.length, 2);
      assert.equal(countOpenSafe(listed), 2);

      const done = await addChatTask(A1, { title: 'Done thing', status: 'done' }, db);
      assert.ok(done.completedAt, 'adding as done stamps completedAt immediately');
      const cancelled = await setChatTaskStatus(A1, { id: first.id, status: 'cancelled', note: 'No longer needed.' }, db);
      assert.equal(cancelled?.status, 'cancelled');

      const open = await listChatTasks(A1, {}, db);
      const everything = await listChatTasks(A1, { includeClosed: true }, db);
      assert.equal(open.length, 1); // only the waiting_on_user backup stays open
      assert.equal(everything.length, 3); // runbook cancelled + backup waiting + Done thing done
      assert.equal(await countOpenChatTasks(A1, db), 1);

      // A done/cancelled item can move back to an open status (the enum is a CHECK, not a rail).
      const reopened = await setChatTaskStatus(A1, { id: cancelled!.id, status: 'pending' }, db);
      assert.equal(reopened?.status, 'pending');
      assert.equal(reopened?.completedAt, null);
    } finally {
      await client.close();
    }
  });

  it('keeps one list per agent and per company — cross-scope reads and writes are impossible', async () => {
    const { client, db } = await freshDb();
    try {
      const task = await addChatTask(A1, { title: 'Private to the Assistant' }, db);
      const other = await addChatTask(A2, { title: 'Private to the other agent' }, db);

      // Agent A2 cannot see agent A1's task (same company)...
      assert.deepEqual((await listChatTasks(A2, {}, db)).map((t) => t.id), [other.id]);
      // ...and neither can an agent in another company.
      assert.deepEqual((await listChatTasks(B1, {}, db)).map((t) => t.id), []);
      assert.equal(await countOpenChatTasks(B1, db), 0);

      // Mutating another agent's (or another company's) task id is a no-op, not a write.
      assert.equal(await updateChatTask(A2, { id: task.id, status: 'cancelled' }, db), null);
      assert.equal(await updateChatTask(B1, { id: task.id, status: 'cancelled' }, db), null);
      assert.equal(await setChatTaskStatus(A2, { id: task.id, status: 'cancelled' }, db), null);
      assert.equal(await setChatTaskStatus(B1, { id: task.id, status: 'cancelled' }, db), null);

      // Still open and untouched in its own scope.
      assert.equal((await listChatTasks(A1, { includeClosed: true }, db)).length, 1);
      assert.equal((await listChatTasks(A1, {}, db))[0].status, 'pending');
      // Even a correct-scope update addressed by a foreign id (id exists, wrong scope) misses.
      assert.equal(await updateChatTask(A1, { id: other.id, status: 'cancelled' }, db), null);
    } finally {
      await client.close();
    }
  });

  it('survives Clear chat: the list is keyed by (company, agent), not by the thread', async () => {
    const { client, db } = await freshDb();
    try {
      const before = await addChatTask(A1, { title: 'Keep me across Clear', sourceThreadId: 'thread-1' }, db);
      // Clear chat: the assistant pins a NEW Mastra thread for the same (company, agent) scope.
      const after = await addChatTask(A1, { title: 'Added after the Clear', sourceThreadId: 'thread-2' }, db);
      const listed = await listChatTasks(A1, {}, db);
      assert.deepEqual(listed.map((t) => t.id), [before.id, after.id]);
      // The audit column still records WHERE each item was created (both threads coexist).
      assert.equal(listed[0].sourceThreadId, 'thread-1');
      assert.equal(listed[1].sourceThreadId, 'thread-2');
    } finally {
      await client.close();
    }
  });

  it('stores requestedBy + notes verbatim enough to keep an interested-parties list (no notify transport)', async () => {
    const { client, db } = await freshDb();
    try {
      const task = await addChatTask(
        A1,
        {
          title: 'Write the postmortem',
          notes: 'Notify: Ops, QA',
          requestedBy: { userId: 'u1', displayName: 'Derek' },
        },
        db,
      );
      assert.equal(task.requestedByUserId, 'u1');
      assert.equal(task.requestedByDisplayName, 'Derek');
      assert.equal(task.notes, 'Notify: Ops, QA');

      // The request-stamp is overridable (Derek's amendment): "that one's Bob's".
      const moved = await updateChatTask(A1, { id: task.id, requestedBy: { displayName: 'Bob' } }, db);
      assert.equal(moved?.requestedByUserId, null);
      assert.equal(moved?.requestedByDisplayName, 'Bob');

      // A status note is appended to the interested-parties list instead of replacing it.
      const closed = await setChatTaskStatus(A1, { id: task.id, status: 'done', note: 'Posted to the wiki.' }, db);
      assert.equal(closed?.notes, 'Notify: Ops, QA\nPosted to the wiki.');
    } finally {
      await client.close();
    }
  });

  it('caps nothing at the query layer but keeps updateChatTask honest on title/position', async () => {
    const { client, db } = await freshDb();
    try {
      const t = await addChatTask(A1, { title: 'Rename me', position: 7 }, db);
      const renamed = await updateChatTask(A1, { id: t.id, title: 'Renamed', position: 2 }, db);
      assert.equal(renamed?.title, 'Renamed');
      assert.equal(renamed?.position, 2);
      // Unknown ids miss cleanly instead of throwing.
      assert.equal(await updateChatTask(A1, { id: 'nope', status: 'done' }, db), null);
      assert.equal(await setChatTaskStatus(A1, { id: 'nope', status: 'done' }, db), null);
    } finally {
      await client.close();
    }
  });
});

function countOpenSafe(list: { status: string }[]): number {
  return list.filter((t) => t.status === 'pending' || t.status === 'in_progress' || t.status === 'waiting_on_user').length;
}
