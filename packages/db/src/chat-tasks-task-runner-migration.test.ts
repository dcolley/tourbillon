/**
 * TASK-RUNNER: migration 0024 (chat_tasks task-runner columns) and its rollback file,
 * against a real Postgres (PGlite, in memory) with the repo's own migrations applied.
 * No external database is touched.
 *
 * B2 (PR #196 hold): the down file must remove the 0024 journal row as well as drop the
 * three columns — otherwise `pnpm db:migrate` after a rollback skips 0024 and the columns
 * never come back. The up/down/up block below fails on a down file that forgets the DELETE.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';

const MIGRATIONS = path.join(__dirname, 'migrations');
const TAG = '0024_chat_tasks_task_runner';
const DOWN_0024 = path.join(__dirname, '..', 'rollback', `${TAG}.down.sql`);
const WHEN_0024 = (
  JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string; when: number }[];
  }
).entries.find((e) => e.tag === TAG)!.when;

/** Same rule as drizzle's migrator; stops at 0024 (later migrations get their own rollback test). */
async function migrateUp(client: PGlite, throughMillis = WHEN_0024): Promise<void> {
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

async function columnExists(client: PGlite, table: string, column: string): Promise<boolean> {
  const res = await client.query<{ n: number }>(
    `select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2`,
    [table, column],
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

const RUNNER_COLUMNS = ['paused', 'runner_attempts', 'runner_last_run_id'] as const;

describe('migration 0024 (chat_tasks task-runner columns)', () => {
  it('is additive: only adds the three task-runner columns to chat_tasks', () => {
    const up = readFileSync(path.join(MIGRATIONS, `${TAG}.sql`), 'utf8');
    for (const stmt of up.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
      assert.match(stmt, /^ALTER TABLE "chat_tasks" ADD COLUMN IF NOT EXISTS "(paused|runner_attempts|runner_last_run_id)"/, stmt);
    }
  });

  it('rollback file only drops the three task-runner columns and the 0024 journal row', () => {
    const stmts = splitStatements(readFileSync(DOWN_0024, 'utf8'));
    assert.deepEqual(stmts, [
      'ALTER TABLE "chat_tasks" DROP COLUMN IF EXISTS "paused"',
      'ALTER TABLE "chat_tasks" DROP COLUMN IF EXISTS "runner_attempts"',
      'ALTER TABLE "chat_tasks" DROP COLUMN IF EXISTS "runner_last_run_id"',
      `DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = ${WHEN_0024}`,
    ]);
  });

  it('up, down, up again; the journal row goes with the columns so re-migrate restores them', async () => {
    const client = new PGlite();
    try {
      // A database "at 0023" (chat_tasks exists, no runner columns) then getting 0024.
      await migrateUp(client);
      for (const col of RUNNER_COLUMNS) {
        assert.equal(await columnExists(client, 'chat_tasks', col), true, `column ${col} after up`);
      }
      assert.equal(await journalRows(client, WHEN_0024), 1);

      // The defaults are the runner contract: unpaused, zero attempts, no last run.
      await client.exec(`
        insert into companies (id, name, slug, issue_prefix) values ('c1', 'C', 'c', 'C');
        insert into agents (id, company_id, name, role, title, url_key) values ('a1', 'c1', 'A', 'general', 'T', 'a');
        insert into chat_tasks (id, company_id, agent_id, title) values ('t1', 'c1', 'a1', 'Draft the runbook');
      `);
      const seeded = (await client.query<{ paused: boolean; runner_attempts: number; runner_last_run_id: string | null }>(
        'select paused, runner_attempts, runner_last_run_id from chat_tasks where id = $1',
        ['t1'],
      )).rows[0]!;
      assert.equal(seeded.paused, false);
      assert.equal(seeded.runner_attempts, 0);
      assert.equal(seeded.runner_last_run_id, null);
      // NOT NULL on the bookkeeping columns (a null attempt budget would silently disable the runner).
      await assert.rejects(
        client.exec(`insert into chat_tasks (id, company_id, agent_id, title, paused) values ('t2', 'c1', 'a1', 'bad paused', null)`),
      );
      const before = await journalRows(client);

      // Down: the three columns go, the chat task list itself survives, journal row removed.
      for (const stmt of splitStatements(readFileSync(DOWN_0024, 'utf8'))) {
        await client.exec(stmt);
      }
      for (const col of RUNNER_COLUMNS) {
        assert.equal(await columnExists(client, 'chat_tasks', col), false, `column ${col} after down`);
      }
      assert.equal(await journalRows(client, WHEN_0024), 0, '0024 journal row must be removed by the down file');
      assert.equal(await journalRows(client), before - 1);
      assert.equal((await client.query('select id from chat_tasks')).rows.length, 1, 'chat tasks themselves survive the rollback');

      // Up again through the normal migrator: WITHOUT the journal-row DELETE this would be a
      // no-op (the journal still claims 0024 ran) and the columns would never come back.
      await migrateUp(client);
      for (const col of RUNNER_COLUMNS) {
        assert.equal(await columnExists(client, 'chat_tasks', col), true, `column ${col} after re-up`);
      }
      assert.equal(await journalRows(client, WHEN_0024), 1);
      assert.equal(await journalRows(client), before);
      // The re-created columns carry the runner defaults again (existing rows back to unpaused).
      const restored = (await client.query<{ paused: boolean; runner_attempts: number }>(
        'select paused, runner_attempts from chat_tasks where id = $1',
        ['t1'],
      )).rows[0]!;
      assert.equal(restored.paused, false);
      assert.equal(restored.runner_attempts, 0);
    } finally {
      await client.close();
    }
  });
});
