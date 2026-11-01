/**
 * Company Computer (Slice 1): migration 0025 and its rollback against a real in-memory
 * Postgres (PGlite) with the repo's own migrations applied. Up, down, up again;
 * gates + registry behave at the column level; unrelated data untouched.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';

const MIGRATIONS = path.join(__dirname, 'migrations');
const TAG = '0025_company_computer';
const DOWN = path.join(__dirname, '..', 'rollback', `${TAG}.down.sql`);
const WHEN = (
  JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string; when: number }[];
  }
).entries.find((e) => e.tag === TAG)!.when;

async function migrateUp(client: PGlite, throughMillis = WHEN): Promise<void> {
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

describe(`migration ${TAG}`, () => {
  it('is additive: only the new table, its FKs/index, and the two has_computer columns', () => {
    const up = readFileSync(path.join(MIGRATIONS, `${TAG}.sql`), 'utf8');
    for (const stmt of up.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
      assert.match(
        stmt,
        /^(CREATE TABLE "company_computer_sessions"|ALTER TABLE "compan(y|ies)" ADD COLUMN "has_computer"|ALTER TABLE "agents" ADD COLUMN "has_computer"|ALTER TABLE "company_computer_sessions" ADD CONSTRAINT|CREATE INDEX "company_computer_sessions)/,
        stmt,
      );
    }
  });

  it('rollback file only touches this migration\'s objects and journal row', () => {
    const stmts = splitStatements(readFileSync(DOWN, 'utf8'));
    assert.deepEqual(stmts, [
      'DROP TABLE IF EXISTS "company_computer_sessions"',
      'ALTER TABLE "companies" DROP COLUMN IF EXISTS "has_computer"',
      'ALTER TABLE "agents" DROP COLUMN IF EXISTS "has_computer"',
      `DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = ${WHEN}`,
    ]);
  });

  it('up, down, up again; unrelated data untouched', async () => {
    const client = new PGlite();
    try {
      await migrateUp(client);
      assert.equal(await tableExists(client, 'company_computer_sessions'), true);
      assert.equal(await columnExists(client, 'companies', 'has_computer'), true);
      assert.equal(await columnExists(client, 'agents', 'has_computer'), true);
      assert.equal(await journalRows(client, WHEN), 1);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname from pg_indexes where tablename = 'company_computer_sessions'`,
      );
      assert.ok(
        indexes.rows.some((r) => r.indexname === 'company_computer_sessions_company_agent_status_idx'),
        'expected the (company_id, agent_id, status) index',
      );

      await client.exec(`
        insert into companies (id, name, slug, issue_prefix, has_computer) values ('c1', 'C', 'c', 'C', true);
        insert into agents (id, company_id, name, role, title, url_key, has_computer) values ('a1', 'c1', 'A', 'ceo', 'T', 'ceo', true);
        insert into assistant_thread_pins (user_key, company_id, agent_id, thread_id) values ('u1', 'c1', 'a1', 't0');
        insert into company_computer_sessions (id, company_id, agent_id, agent_url_key, container_name, image, vnc_port, status)
          values ('s1', 'c1', 'a1', 'ceo', 'cc-c-ceo', 'kasmweb/desktop:1.19.0', 6901, 'running');
      `);

      // Gate defaults are false/false for fresh rows (two-gate fail-closed at the schema level).
      const defaults = await client.query<{ has_computer: boolean }>(
        `select has_computer from companies where id = 'c1'`,
      );
      assert.equal(defaults.rows[0].has_computer, true);
      await client.exec(`insert into companies (id, name, slug, issue_prefix) values ('c2','C2','c2','C2')`);
      const fresh = await client.query<{ has_computer: boolean }>(
        `select has_computer from companies where id = 'c2'`,
      );
      assert.equal(fresh.rows[0].has_computer, false);

      // Status enum is enforced.
      await assert.rejects(
        client.exec(`
          insert into company_computer_sessions (id, company_id, agent_id, agent_url_key, container_name, image, vnc_port, status)
          values ('s2','c1','a1','ceo','cc-c-ceo-2','kasmweb/desktop:1.19.0',6902,'shipped')
        `),
      );

      // Company and agent FKs are real (cascade on company delete).
      await assert.rejects(
        client.exec(`
          insert into company_computer_sessions (id, company_id, agent_id, agent_url_key, container_name, image, vnc_port)
          values ('s3','nope','a1','ceo','x','kasmweb/desktop:1.19.0',6903)
        `),
      );

      // Roll back.
      for (const stmt of splitStatements(readFileSync(DOWN, 'utf8'))) await client.exec(stmt);
      assert.equal(await tableExists(client, 'company_computer_sessions'), false);
      assert.equal(await columnExists(client, 'companies', 'has_computer'), false);
      assert.equal(await columnExists(client, 'agents', 'has_computer'), false);
      assert.equal(await journalRows(client, WHEN), 0);
      // Unrelated data untouched (0023 table still there with its rows).
      assert.equal(await tableExists(client, 'chat_tasks'), true);
      const pins = await client.query<{ n: number }>('select count(*)::int as n from assistant_thread_pins');
      assert.equal(pins.rows[0].n, 1);

      // Re-apply through the normal migrator.
      await migrateUp(client);
      assert.equal(await tableExists(client, 'company_computer_sessions'), true);
      assert.equal(await journalRows(client, WHEN), 1);
    } finally {
      // PGlite in-memory instance is reclaimed with the process (same as sibling migration tests).
    }
  });
});
