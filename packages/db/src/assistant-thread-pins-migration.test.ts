/**
 * UI-2: migration 0019 (assistant_thread_pins) and its rollback file, against a real Postgres
 * (PGlite, in memory) with the repo's own migrations applied. No external database is touched.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';

const MIGRATIONS = path.join(__dirname, 'migrations');
const TAG = '0019_assistant_thread_pins';
const DOWN_0019 = path.join(__dirname, '..', 'rollback', `${TAG}.down.sql`);
const WHEN_0019 = (
  JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string; when: number }[];
  }
).entries.find((e) => e.tag === TAG)!.when;

/** Same rule as drizzle's migrator; simple protocol because early migrations hold several statements per chunk. */
async function migrateUp(client: PGlite): Promise<void> {
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

describe('migration 0019 (assistant_thread_pins)', () => {
  it('is additive: only creates the new table, its FKs and index', () => {
    const up = readFileSync(path.join(MIGRATIONS, `${TAG}.sql`), 'utf8');
    for (const stmt of up.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
      assert.match(
        stmt,
        /^(CREATE TABLE "assistant_thread_pins"|ALTER TABLE "assistant_thread_pins" ADD CONSTRAINT|CREATE INDEX "assistant_thread_pins_user_agent_idx" ON "assistant_thread_pins")/,
        stmt,
      );
    }
  });

  it('rollback file only touches assistant_thread_pins and the 0019 journal row', () => {
    const stmts = splitStatements(readFileSync(DOWN_0019, 'utf8'));
    assert.deepEqual(stmts, [
      'DROP INDEX IF EXISTS "assistant_thread_pins_user_agent_idx"',
      'DROP TABLE IF EXISTS "assistant_thread_pins"',
      `DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = ${WHEN_0019}`,
    ]);
  });

  it('up, down, up again; existing data untouched', async () => {
    const client = new PGlite();
    try {
      await migrateUp(client);
      assert.equal(await tableExists(client, 'assistant_thread_pins'), true);
      assert.equal(await journalRows(client, WHEN_0019), 1);
      await client.exec(`
        insert into companies (id, name, slug, issue_prefix) values ('c1', 'C', 'c', 'C');
        insert into agents (id, company_id, name, role, title, url_key) values ('a1', 'c1', 'A', 'general', 'T', 'a');
        insert into assistant_thread_pins (user_key, company_id, agent_id, thread_id) values ('u1', 'c1', 'a1', 't1');
      `);
      const before = await journalRows(client);

      // Down
      for (const stmt of splitStatements(readFileSync(DOWN_0019, 'utf8'))) {
        await client.exec(stmt);
      }
      assert.equal(await tableExists(client, 'assistant_thread_pins'), false);
      assert.equal(await journalRows(client, WHEN_0019), 0);
      assert.equal(await journalRows(client), before - 1);
      assert.equal((await client.query('select id from companies')).rows.length, 1);
      assert.equal((await client.query('select id from agents')).rows.length, 1);
      // Earlier migrations stay applied.
      assert.equal(await tableExists(client, 'company_llm_providers'), true);

      // Up again through the normal migrator: only 0019 runs.
      await migrateUp(client);
      assert.equal(await tableExists(client, 'assistant_thread_pins'), true);
      assert.equal(await journalRows(client, WHEN_0019), 1);
      assert.equal(await journalRows(client), before);
      assert.equal((await client.query('select * from assistant_thread_pins')).rows.length, 0);
      const constraints = await client.query<{ conname: string }>(
        `select conname from pg_constraint where conrelid = 'public.assistant_thread_pins'::regclass and contype in ('p', 'f') order by 1`,
      );
      assert.deepEqual(
        constraints.rows.map((r) => r.conname),
        [
          'assistant_thread_pins_agent_id_agents_id_fk',
          'assistant_thread_pins_company_id_companies_id_fk',
          'assistant_thread_pins_user_key_thread_id_pk',
        ],
      );
    } finally {
      await client.close();
    }
  });
});
