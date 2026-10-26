/**
 * TASK-1: migration 0023 (chat_tasks) and its rollback file, against a real Postgres
 * (PGlite, in memory) with the repo's own migrations applied. No external database is touched.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';

const MIGRATIONS = path.join(__dirname, 'migrations');
const TAG = '0023_chat_tasks';
const DOWN_0023 = path.join(__dirname, '..', 'rollback', `${TAG}.down.sql`);
const WHEN_0023 = (
  JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string; when: number }[];
  }
).entries.find((e) => e.tag === TAG)!.when;

/** Same rule as drizzle's migrator; stops at 0023 (later migrations get their own rollback test). */
async function migrateUp(client: PGlite, throughMillis = WHEN_0023): Promise<void> {
  await client.exec(`
    create schema if not exists drizzle;
    create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
  `);
  const last = await client.query<{ created_at: string | null }>(
    'select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1',
  );
  const lastAt = last.rows[0]?.created_at ? Number(last.rows[0].created_at) : 0;
  for (const m of readMigrationFiles({ migrationsFolder: MIGRATIONS })) {
    if (m.folderMillis <= lastAt) continue;
    if (m.folderMillis > throughMillis) break;
    for (const chunk of m.sql) {
      if (chunk.trim()) await client.exec(chunk);
    }
    await client.query('insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)', [
      m.hash,
      m.folderMillis,
    ]);
  }
}

function splitStatements(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function tableExists(client: PGlite, name: string): Promise<boolean> {
  const res = await client.query<{ n: number }>(
    `select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = $1`,
    [name],
  );
  return res.rows[0].n === 1;
}

async function journalRows(client: PGlite, createdAt?: number): Promise<number> {
  const res = createdAt === undefined
    ? await client.query<{ n: number }>('select count(*)::int as n from drizzle.__drizzle_migrations')
    : await client.query<{ n: number }>(
        'select count(*)::int as n from drizzle.__drizzle_migrations where created_at = $1',
        [createdAt],
      );
  return res.rows[0].n;
}

describe('migration 0023 (chat_tasks)', () => {
  it('is additive: only creates the new table, its FKs and its index', () => {
    const up = readFileSync(path.join(MIGRATIONS, `${TAG}.sql`), 'utf8');
    for (const stmt of up.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
      assert.match(
        stmt,
        /^(CREATE TABLE "chat_tasks"|ALTER TABLE "chat_tasks" ADD CONSTRAINT|CREATE INDEX "chat_tasks)/,
        stmt,
      );
    }
  });

  it('rollback file only touches chat_tasks and the 0023 journal row', () => {
    const stmts = splitStatements(readFileSync(DOWN_0023, 'utf8'));
    assert.deepEqual(stmts, [
      'DROP TABLE IF EXISTS "chat_tasks"',
      `DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = ${WHEN_0023}`,
    ]);
  });

  it('up, down, up again; existing data untouched', async () => {
    const client = new PGlite();
    try {
      // A database "at 0022" then getting 0023 is exactly this: the full journal applied,
      // with 0023 last. If 0023 does not apply cleanly on top of 0022 this whole block fails.
      await migrateUp(client);
      assert.equal(await tableExists(client, 'chat_tasks'), true);
      assert.equal(await journalRows(client, WHEN_0023), 1);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname from pg_indexes where tablename = 'chat_tasks'`,
      );
      assert.ok(
        indexes.rows.some((r) => r.indexname === 'chat_tasks_company_agent_status_idx'),
        'expected the (company_id, agent_id, status) index',
      );

      await client.exec(`
        insert into companies (id, name, slug, issue_prefix) values ('c1', 'C', 'c', 'C');
        insert into agents (id, company_id, name, role, title, url_key) values ('a1', 'c1', 'A', 'general', 'T', 'a');
        insert into assistant_thread_pins (user_key, company_id, agent_id, thread_id) values ('u1', 'c1', 'a1', 't0');
        insert into chat_tasks (id, company_id, agent_id, title) values ('t1', 'c1', 'a1', 'Draft the runbook');
        insert into chat_tasks (id, company_id, agent_id, title, status) values ('t2', 'c1', 'a1', 'Check the restore backup', 'done');
      `);
      // The status CHECK rejects anything outside the five known statuses.
      await assert.rejects(
        client.exec(`insert into chat_tasks (id, company_id, agent_id, title, status) values ('t3', 'c1', 'a1', 'bad status', 'shipped')`),
      );
      // The company FK and the agent FK are real.
      await assert.rejects(
        client.exec(`insert into chat_tasks (id, company_id, agent_id, title) values ('t4', 'nope', 'a1', 'bad company')`),
      );
      await assert.rejects(
        client.exec(`insert into chat_tasks (id, company_id, agent_id, title) values ('t5', 'c1', 'nope', 'bad agent')`),
      );
      const before = await journalRows(client);

      // Down.
      for (const stmt of splitStatements(readFileSync(DOWN_0023, 'utf8'))) {
        await client.exec(stmt);
      }
      assert.equal(await tableExists(client, 'chat_tasks'), false);
      assert.equal(await journalRows(client, WHEN_0023), 0);
      assert.equal(await journalRows(client), before - 1);
      assert.equal((await client.query('select id from companies')).rows.length, 1);
      assert.equal((await client.query('select id from agents')).rows.length, 1);
      // An unrelated 0022-era table is untouched.
      assert.equal((await client.query('select thread_id from assistant_thread_pins')).rows.length, 1);

      // Up again through the normal migrator: only 0023 runs, and the list comes back empty
      // (the down file drops the whole table — there is no per-row archive).
      await migrateUp(client);
      assert.equal(await tableExists(client, 'chat_tasks'), true);
      assert.equal(await journalRows(client, WHEN_0023), 1);
      assert.equal(await journalRows(client), before);
      assert.equal((await client.query('select * from chat_tasks')).rows.length, 0);
    } finally {
      await client.close();
    }
  });
});
