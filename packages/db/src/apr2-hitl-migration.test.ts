/**
 * APR-2: migration 0020 (hitl request/response columns, hitl_events, hitl_link_tokens) and its
 * rollback file, against a real Postgres (PGlite, in memory) with the repo's own migrations
 * applied. Also checks the claim and idempotency rules the app relies on at the SQL level.
 * No external database is touched.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';

const MIGRATIONS = path.join(__dirname, 'migrations');
const TAG = '0020_apr2_hitl';
const DOWN = path.join(__dirname, '..', 'rollback', `${TAG}.down.sql`);
const WHEN = (
  JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string; when: number }[];
  }
).entries.find((e) => e.tag === TAG)!.when;
const NEW_COLUMNS = ['deadline', 'hitl_request', 'hitl_response', 'idempotency_key', 'presented_at'];

/** Same rule as drizzle's migrator; stops at 0020 so it can be re-applied while it is the latest. */
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

async function count(client: PGlite, q: string, params: unknown[] = []): Promise<number> {
  return (await client.query<{ n: number }>(q, params)).rows[0].n;
}
const tableExists = (client: PGlite, name: string) =>
  count(client, `select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = $1`, [name]).then((n) => n === 1);
async function approvalColumns(client: PGlite): Promise<string[]> {
  const r = await client.query<{ c: string }>(
    `select column_name as c from information_schema.columns where table_schema = 'public' and table_name = 'approvals' order by 1`,
  );
  return r.rows.map((x) => x.c);
}
const indexExists = (client: PGlite, name: string) =>
  count(client, `select count(*)::int as n from pg_indexes where indexname = $1`, [name]).then((n) => n === 1);

async function seed(client: PGlite) {
  await client.exec(`
    insert into companies (id, name, slug, issue_prefix) values ('c1', 'C', 'c', 'C');
    insert into agents (id, company_id, name, role, title, url_key) values ('a1', 'c1', 'A', 'general', 'T', 'a');
    insert into approvals (id, company_id, type, requested_by_agent_id, payload) values ('legacy', 'c1', 'request_board_approval', 'a1', '{"title":"Old"}');
  `);
}

describe('migration 0020 (apr2_hitl)', () => {
  it('is additive: new tables, nullable approvals columns, indexes and FKs only', () => {
    const up = readFileSync(path.join(MIGRATIONS, `${TAG}.sql`), 'utf8');
    for (const stmt of up.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
      assert.match(
        stmt,
        /^(CREATE TABLE "hitl_(events|link_tokens)"|ALTER TABLE "hitl_(events|link_tokens)" ADD CONSTRAINT|ALTER TABLE "approvals" ADD COLUMN "(hitl_request|hitl_response|idempotency_key|deadline|presented_at)" (jsonb|text|timestamp with time zone);$|CREATE (UNIQUE )?INDEX "(hitl_events_approval_seq_uidx|hitl_link_tokens_binding_uidx|hitl_link_tokens_company_idx|approvals_idempotency_uidx|approvals_pending_deadline_idx)")/,
        stmt,
      );
    }
  });

  it('rollback file only touches 0020 objects and the 0020 journal row', () => {
    assert.deepEqual(splitStatements(readFileSync(DOWN, 'utf8')), [
      'DROP INDEX IF EXISTS "approvals_pending_deadline_idx"',
      'DROP INDEX IF EXISTS "approvals_idempotency_uidx"',
      'DROP TABLE IF EXISTS "hitl_link_tokens"',
      'DROP TABLE IF EXISTS "hitl_events"',
      'ALTER TABLE "approvals" DROP COLUMN IF EXISTS "presented_at"',
      'ALTER TABLE "approvals" DROP COLUMN IF EXISTS "deadline"',
      'ALTER TABLE "approvals" DROP COLUMN IF EXISTS "idempotency_key"',
      'ALTER TABLE "approvals" DROP COLUMN IF EXISTS "hitl_response"',
      'ALTER TABLE "approvals" DROP COLUMN IF EXISTS "hitl_request"',
      `DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = ${WHEN}`,
    ]);
  });

  it('up, down, up again; legacy approvals untouched', async () => {
    const client = new PGlite();
    try {
      await migrateUp(client);
      await seed(client);
      for (const c of NEW_COLUMNS) assert.ok((await approvalColumns(client)).includes(c), c);
      await client.exec(`
        insert into approvals (id, company_id, type, requested_by_agent_id, hitl_request, idempotency_key, deadline)
          values ('h1', 'c1', 'request_board_approval', 'a1', '{"spec":"hitl/request/v0"}', 'k1', now() + interval '1 day');
        insert into hitl_events (id, company_id, approval_id, seq, type, at, actor_kind, actor_id, source, hash)
          values ('e1', 'c1', 'h1', 1, 'presented', now(), 'group', 'board', 'host', 'x');
        insert into hitl_link_tokens (token, company_id, approval_id, item_ref, reviewer_kind, reviewer_id)
          values ('t1', 'c1', 'h1', 'lnk', 'group', 'board');
      `);
      const before = await count(client, 'select count(*)::int as n from drizzle.__drizzle_migrations');

      for (const stmt of splitStatements(readFileSync(DOWN, 'utf8'))) await client.exec(stmt);
      assert.equal(await tableExists(client, 'hitl_events'), false);
      assert.equal(await tableExists(client, 'hitl_link_tokens'), false);
      for (const c of NEW_COLUMNS) assert.ok(!(await approvalColumns(client)).includes(c), c);
      assert.equal(await indexExists(client, 'approvals_idempotency_uidx'), false);
      assert.equal(await count(client, 'select count(*)::int as n from drizzle.__drizzle_migrations where created_at = $1', [WHEN]), 0);
      assert.equal(await count(client, 'select count(*)::int as n from drizzle.__drizzle_migrations'), before - 1);
      const legacy = await client.query<{ payload: unknown; status: string }>(`select payload, status from approvals where id = 'legacy'`);
      assert.deepEqual(legacy.rows[0], { payload: { title: 'Old' }, status: 'pending' });
      assert.equal(await tableExists(client, 'assistant_thread_pins'), true, '0019 stays applied');

      await migrateUp(client);
      assert.equal(await tableExists(client, 'hitl_events'), true);
      assert.equal(await tableExists(client, 'hitl_link_tokens'), true);
      for (const c of NEW_COLUMNS) assert.ok((await approvalColumns(client)).includes(c), c);
      assert.equal(await indexExists(client, 'approvals_pending_deadline_idx'), true);
      assert.equal(await count(client, 'select count(*)::int as n from drizzle.__drizzle_migrations'), before);
      const again = await client.query<{ hitl_request: unknown }>(`select hitl_request from approvals where id = 'legacy'`);
      assert.equal(again.rows[0].hitl_request, null);
    } finally {
      await client.close();
    }
  });

  it('idempotency key is unique per company and requester; claims apply once', async () => {
    const client = new PGlite();
    try {
      await migrateUp(client);
      await seed(client);
      const insert = (id: string) =>
        client.query(
          `insert into approvals (id, company_id, type, requested_by_agent_id, idempotency_key) values ($1, 'c1', 't', 'a1', 'same')
           on conflict do nothing returning id`,
          [id],
        );
      assert.equal((await insert('i1')).rows.length, 1);
      assert.equal((await insert('i2')).rows.length, 0, 'repeat key is refused by the unique index');

      // Decide vs expiry on one pending row: the status = 'pending' conditional update wins once.
      await client.exec(`update approvals set deadline = now() - interval '1 minute' where id = 'i1'`);
      const decide = `update approvals set status = 'approved', hitl_response = '{"status":"answered"}' where id = 'i1' and company_id = 'c1' and status = 'pending' returning id`;
      const expire = `update approvals set status = 'expired', hitl_response = '{"status":"expired"}' where id = 'i1' and company_id = 'c1' and status = 'pending' and deadline <= now() returning id`;
      const results = await Promise.all([client.query(expire), client.query(decide)]);
      assert.deepEqual(results.map((r) => r.rows.length).sort(), [0, 1]);
      const row = await client.query<{ status: string; hitl_response: { status: string } }>(`select status, hitl_response from approvals where id = 'i1'`);
      assert.equal(row.rows[0].status, 'expired');
      assert.equal(row.rows[0].hitl_response.status, 'expired', 'response written by the winning claim only');

      // Cross-company: a claim scoped to another company never matches.
      const other = await client.query(`update approvals set status = 'approved' where id = 'legacy' and company_id = 'c2' and status = 'pending' returning id`);
      assert.equal(other.rows.length, 0);

      // Event chain order is unique per approval.
      await client.exec(`insert into hitl_events (id, company_id, approval_id, seq, type, at, actor_kind, actor_id, source, hash) values ('e1', 'c1', 'i1', 1, 'presented', now(), 'group', 'board', 'host', 'h')`);
      await assert.rejects(
        client.exec(`insert into hitl_events (id, company_id, approval_id, seq, type, at, actor_kind, actor_id, source, hash) values ('e2', 'c1', 'i1', 1, 'opened', now(), 'group', 'board', 'host', 'h')`),
      );
      // Deleting the approval removes its events and tokens.
      await client.exec(`insert into hitl_link_tokens (token, company_id, approval_id, reviewer_kind, reviewer_id) values ('t1', 'c1', 'i1', 'group', 'board')`);
      await client.exec(`delete from approvals where id = 'i1'`);
      assert.equal(await count(client, 'select count(*)::int as n from hitl_events'), 0);
      assert.equal(await count(client, 'select count(*)::int as n from hitl_link_tokens'), 0);
    } finally {
      await client.close();
    }
  });
});
