/**
 * ACT-1: migration 0021 (activity_log correlation id + indexes) and its rollback file, against a
 * real Postgres (PGlite, in memory) with the repo's own migrations applied. No external database is
 * touched.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';

const MIGRATIONS = path.join(__dirname, 'migrations');
const TAG = '0021_act1_activity_detail';
const DOWN_0021 = path.join(__dirname, '..', 'rollback', `${TAG}.down.sql`);
const WHEN_0021 = (
  JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string; when: number }[];
  }
).entries.find((e) => e.tag === TAG)!.when;

const INDEXES = [
  'activity_log_company_correlation_idx',
  'activity_log_company_created_idx',
  'activity_log_company_entity_idx',
];

/** Same rule as drizzle's migrator; stops at 0021 (later migrations have their own rollback tests). */
async function migrateUp(client: PGlite, throughMillis = WHEN_0021): Promise<void> {
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

async function activityIndexes(client: PGlite): Promise<string[]> {
  const res = await client.query<{ indexname: string }>(
    `select indexname from pg_indexes where schemaname = 'public' and tablename = 'activity_log' and indexname <> 'activity_log_pkey' order by 1`,
  );
  return res.rows.map((r) => r.indexname);
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

describe('migration 0021 (act1_activity_detail)', () => {
  it('is additive: one nullable column and three indexes on activity_log', () => {
    const up = readFileSync(path.join(MIGRATIONS, `${TAG}.sql`), 'utf8');
    const stmts = up.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
    assert.equal(stmts.length, 4);
    for (const stmt of stmts) {
      assert.match(
        stmt,
        /^(ALTER TABLE "activity_log" ADD COLUMN "correlation_id" text;?$|CREATE INDEX "activity_log_company_(created|entity|correlation)_idx" ON "activity_log")/,
        stmt,
      );
    }
  });

  it('rollback file only touches the 0021 column, indexes and journal row', () => {
    const stmts = splitStatements(readFileSync(DOWN_0021, 'utf8'));
    assert.deepEqual(stmts, [
      'DROP INDEX IF EXISTS "activity_log_company_correlation_idx"',
      'DROP INDEX IF EXISTS "activity_log_company_entity_idx"',
      'DROP INDEX IF EXISTS "activity_log_company_created_idx"',
      'ALTER TABLE "activity_log" DROP COLUMN IF EXISTS "correlation_id"',
      `DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = ${WHEN_0021}`,
    ]);
  });

  it('up, down, up again; activity rows are kept', async () => {
    const client = new PGlite();
    try {
      await migrateUp(client);
      assert.equal(await columnExists(client, 'activity_log', 'correlation_id'), true);
      assert.deepEqual(await activityIndexes(client), INDEXES);
      assert.equal(await journalRows(client, WHEN_0021), 1);
      await client.exec(`
        insert into companies (id, name, slug, issue_prefix) values ('c1', 'C', 'c', 'C');
        insert into activity_log (id, company_id, actor_type, actor_id, action, entity_type, entity_id, details, correlation_id)
          values ('l1', 'c1', 'user', 'board', 'approval.decided', 'approval', 'ap1', '{"status":"approved"}', 'k1'),
                 ('l2', 'c1', 'system', 'board', 'issue.updated', 'issue', 'i1', '{"status":"todo"}', 'k1'),
                 ('l3', 'c1', 'agent', 'a1', 'issue.commented', 'issue', 'i1', '{}', null);
      `);
      const before = await journalRows(client);

      // Down
      for (const stmt of splitStatements(readFileSync(DOWN_0021, 'utf8'))) {
        await client.exec(stmt);
      }
      assert.equal(await columnExists(client, 'activity_log', 'correlation_id'), false);
      assert.deepEqual(await activityIndexes(client), []);
      assert.equal(await journalRows(client, WHEN_0021), 0);
      assert.equal(await journalRows(client), before - 1);
      const kept = await client.query<{ id: string; action: string }>('select id, action from activity_log order by id');
      assert.deepEqual(kept.rows.map((r) => r.id), ['l1', 'l2', 'l3']);
      assert.equal((await client.query('select id from companies')).rows.length, 1);
      // Earlier migrations stay applied.
      assert.equal(await columnExists(client, 'approvals', 'hitl_request'), true);

      // Up again through the normal migrator: only 0021 runs.
      await migrateUp(client);
      assert.equal(await columnExists(client, 'activity_log', 'correlation_id'), true);
      assert.deepEqual(await activityIndexes(client), INDEXES);
      assert.equal(await journalRows(client, WHEN_0021), 1);
      assert.equal(await journalRows(client), before);
      const after = await client.query<{ id: string; correlation_id: string | null }>(
        'select id, correlation_id from activity_log order by id',
      );
      assert.deepEqual(after.rows, [
        { id: 'l1', correlation_id: null },
        { id: 'l2', correlation_id: null },
        { id: 'l3', correlation_id: null },
      ]);
    } finally {
      await client.close();
    }
  });
});
