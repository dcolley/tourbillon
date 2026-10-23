/**
 * PRV-1: per-company provider enablement against a real Postgres (PGlite, in memory), with the
 * repo's own migrations applied. No external database is touched.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { sql } from 'drizzle-orm';

// The query module imports the app pool, which only validates the URL format (no connection).
process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/unused';

const MIGRATIONS = path.join(__dirname, 'migrations');
const DOWN_0018 = path.join(__dirname, '..', 'rollback', '0018_slippery_justin_hammer.down.sql');

type Queries = typeof import('./company-llm-provider-queries');
type Schema = typeof import('./schema/index');

/**
 * Applies pending journal migrations the way drizzle's migrator does (skip anything at or before
 * the last recorded `created_at`, record hash + timestamp). Statements go through PGlite's simple
 * protocol because an early migration (0009) holds several statements in one chunk, which the
 * extended protocol used by drizzle's PGlite migrator rejects; the postgres-js pool used in the
 * app runs unprepared, so it is unaffected.
 */
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

async function freshDb(schema: Schema) {
  const client = new PGlite();
  const database = drizzle(client, { schema });
  await migrateUp(client);
  return { client, database };
}

async function tableExists(client: PGlite, name: string): Promise<boolean> {
  const res = await client.query<{ n: number }>(
    `select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = $1`,
    [name],
  );
  return res.rows[0].n === 1;
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

describe('company_llm_providers', () => {
  let q: Queries;
  let schema: Schema;
  let client: PGlite;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let database: any;

  before(async () => {
    schema = await import('./schema/index');
    q = await import('./company-llm-provider-queries');
    ({ client, database } = await freshDb(schema));
  });

  after(async () => {
    await client.close();
  });

  beforeEach(async () => {
    await database.execute(sql`delete from activity_log`);
    await database.execute(sql`delete from company_llm_providers`);
    await database.execute(sql`delete from llm_providers`);
    await database.execute(sql`delete from companies`);
    await database.insert(schema.companies).values([
      { id: 'co-a', name: 'Alpha', slug: 'alpha', issuePrefix: 'ALP' },
      { id: 'co-b', name: 'Beta', slug: 'beta', issuePrefix: 'BET' },
    ]);
    await database.insert(schema.llmProviders).values([
      { id: 'p-default', name: 'Default gateway', type: 'openai-compatible', baseURL: 'http://gw.test/v1', isDefault: true },
      { id: 'p-local', name: 'Local studio', type: 'lmstudio', baseURL: 'http://studio.test/v1' },
      { id: 'p-cloud', name: 'Cloud', type: 'openai', baseURL: 'http://cloud.test/v1' },
    ]);
  });

  const actor = { actorType: 'user' as const, actorId: 'dashboard', actorName: 'Dashboard' };

  describe('queries', () => {
    it('every provider is on by default (no rows)', async () => {
      assert.equal(await q.isLlmProviderEnabledForCompany('co-a', 'p-local', database), true);
      assert.equal((await q.listDisabledLlmProviderIds('co-a', database)).size, 0);
      assert.deepEqual(await q.listCompanyLlmProviderSettings('co-a', database), []);
    });

    it('disable then enable round-trips, one row per company+provider', async () => {
      const off = await q.setCompanyLlmProviderEnabled(
        { companyId: 'co-a', providerId: 'p-local', enabled: false, actor },
        database,
      );
      assert.equal(off?.setting.enabled, false);
      assert.equal(off?.setting.updatedBy, 'dashboard');
      assert.equal(off?.changed, true);
      assert.equal(await q.isLlmProviderEnabledForCompany('co-a', 'p-local', database), false);
      assert.deepEqual([...(await q.listDisabledLlmProviderIds('co-a', database))], ['p-local']);

      const on = await q.setCompanyLlmProviderEnabled(
        { companyId: 'co-a', providerId: 'p-local', enabled: true, actor },
        database,
      );
      assert.equal(on?.setting.enabled, true);
      assert.equal(await q.isLlmProviderEnabledForCompany('co-a', 'p-local', database), true);
      assert.equal((await q.listCompanyLlmProviderSettings('co-a', database)).length, 1);
    });

    it('switching a provider off for one company leaves other companies unaffected', async () => {
      await q.setCompanyLlmProviderEnabled(
        { companyId: 'co-a', providerId: 'p-local', enabled: false, actor },
        database,
      );
      assert.equal(await q.isLlmProviderEnabledForCompany('co-b', 'p-local', database), true);
      assert.equal((await q.listDisabledLlmProviderIds('co-b', database)).size, 0);
    });

    it('writes one activity row per toggle', async () => {
      await q.setCompanyLlmProviderEnabled(
        { companyId: 'co-a', providerId: 'p-cloud', enabled: false, actor },
        database,
      );
      await q.setCompanyLlmProviderEnabled(
        { companyId: 'co-a', providerId: 'p-cloud', enabled: true, actor },
        database,
      );
      const rows = await database
        .select()
        .from(schema.activityLog)
        .orderBy(schema.activityLog.createdAt);
      assert.equal(rows.length, 2);
      assert.deepEqual(
        rows.map((r: { action: string }) => r.action).sort(),
        ['llm_provider.disabled_for_company', 'llm_provider.enabled_for_company'],
      );
      for (const r of rows) {
        assert.equal(r.companyId, 'co-a');
        assert.equal(r.entityType, 'llm_provider');
        assert.equal(r.entityId, 'p-cloud');
        assert.equal(r.actorId, 'dashboard');
      }
    });

    it('unknown provider → null, nothing written', async () => {
      const res = await q.setCompanyLlmProviderEnabled(
        { companyId: 'co-a', providerId: 'nope', enabled: false, actor },
        database,
      );
      assert.equal(res, null);
      assert.equal((await database.select().from(schema.activityLog)).length, 0);
    });

    it('deleting a provider or company removes its switches (cascade)', async () => {
      await q.setCompanyLlmProviderEnabled(
        { companyId: 'co-a', providerId: 'p-cloud', enabled: false, actor },
        database,
      );
      await database.execute(sql`delete from llm_providers where id = 'p-cloud'`);
      assert.equal((await q.listCompanyLlmProviderSettings('co-a', database)).length, 0);
    });
  });

  describe('resolveCompanyLlmProviderRow', () => {
    it('enabled provider → used as-is', async () => {
      const res = await q.resolveCompanyLlmProviderRow('co-a', 'p-local', database);
      assert.equal(res.row?.id, 'p-local');
      assert.equal(res.fallbackFrom, null);
    });

    it('disabled provider → company default, with the original reported', async () => {
      await q.setCompanyLlmProviderEnabled(
        { companyId: 'co-a', providerId: 'p-local', enabled: false, actor },
        database,
      );
      const res = await q.resolveCompanyLlmProviderRow('co-a', 'p-local', database);
      assert.equal(res.row?.id, 'p-default');
      assert.equal(res.fallbackFrom?.id, 'p-local');
      // Other company still on its own choice.
      const other = await q.resolveCompanyLlmProviderRow('co-b', 'p-local', database);
      assert.equal(other.row?.id, 'p-local');
    });

    it('none enabled → NoEnabledLlmProviderError', async () => {
      for (const id of ['p-default', 'p-local', 'p-cloud']) {
        await q.setCompanyLlmProviderEnabled(
          { companyId: 'co-a', providerId: id, enabled: false, actor },
          database,
        );
      }
      await assert.rejects(
        q.resolveCompanyLlmProviderRow('co-a', 'p-local', database),
        (err: unknown) =>
          err instanceof q.NoEnabledLlmProviderError &&
          /No LLM provider is enabled for this company/.test(err.message),
      );
    });

    it('agent without a provider keeps the existing path (null row)', async () => {
      const res = await q.resolveCompanyLlmProviderRow('co-a', null, database);
      assert.deepEqual(res, { row: null, fallbackFrom: null });
    });

    it('records a warning activity row for a fallback', async () => {
      await q.recordLlmProviderFallback(
        {
          companyId: 'co-a',
          agentId: 'agent-1',
          agentName: 'Writer',
          from: { id: 'p-local', name: 'Local studio' },
          to: { id: 'p-default', name: 'Default gateway' },
          context: 'heartbeat',
          runId: 'run-1',
        },
        database,
      );
      const [row] = await database.select().from(schema.activityLog);
      assert.equal(row.action, 'llm_provider.fallback');
      assert.equal(row.entityType, 'agent');
      assert.equal(row.entityId, 'agent-1');
      assert.equal(row.details.level, 'warning');
      assert.equal(row.details.runId, 'run-1');
      assert.match(row.details.message, /Local studio is switched off.*Writer ran on Default gateway/);
    });
  });
});

describe('migration 0018 (company_llm_providers)', () => {
  it('is additive: only creates the new table, its FKs and index', () => {
    const up = readFileSync(path.join(MIGRATIONS, '0018_slippery_justin_hammer.sql'), 'utf8');
    for (const stmt of up.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
      assert.match(
        stmt,
        /^(CREATE TABLE "company_llm_providers"|ALTER TABLE "company_llm_providers" ADD CONSTRAINT|CREATE UNIQUE INDEX "company_llm_providers_company_provider_uidx" ON "company_llm_providers")/,
        stmt,
      );
    }
  });

  it('up, down, up again; existing data untouched', async () => {
    const schema = await import('./schema/index');
    const { client, database } = await freshDb(schema);
    try {
      assert.equal(await tableExists(client, 'company_llm_providers'), true);
      await database.insert(schema.companies).values({ id: 'c1', name: 'C', slug: 'c', issuePrefix: 'C' });
      await database
        .insert(schema.llmProviders)
        .values({ id: 'p1', name: 'P', type: 'lmstudio', baseURL: 'http://p.test/v1' });
      await database.insert(schema.companyLlmProviders).values({ companyId: 'c1', providerId: 'p1', enabled: false });
      const before = await client.query<{ n: number }>('select count(*)::int as n from drizzle.__drizzle_migrations');

      // Down
      for (const stmt of splitStatements(readFileSync(DOWN_0018, 'utf8'))) {
        await client.exec(stmt);
      }
      assert.equal(await tableExists(client, 'company_llm_providers'), false);
      const afterDown = await client.query<{ n: number }>('select count(*)::int as n from drizzle.__drizzle_migrations');
      assert.equal(afterDown.rows[0].n, before.rows[0].n - 1);
      const providers = await client.query('select id from llm_providers');
      assert.equal(providers.rows.length, 1);
      const companies = await client.query('select id from companies');
      assert.equal(companies.rows.length, 1);

      // Up again through the normal migrator.
      await migrateUp(client);
      assert.equal(await tableExists(client, 'company_llm_providers'), true);
      const rows = await client.query('select * from company_llm_providers');
      assert.equal(rows.rows.length, 0);
    } finally {
      await client.close();
    }
  });
});

describe('chooseCompanyLlmProvider (pure)', () => {
  let q: Queries;
  before(async () => {
    q = await import('./company-llm-provider-queries');
  });
  const providers = [
    { id: 'b', name: 'Bravo', isDefault: false },
    { id: 'd', name: 'Delta', isDefault: true },
    { id: 'a', name: 'Alpha', isDefault: false },
  ];

  it('enabled → requested', () => {
    assert.deepEqual(
      q.chooseCompanyLlmProvider({ requestedProviderId: 'b', providers, disabledProviderIds: new Set() }),
      { kind: 'requested', providerId: 'b' },
    );
  });
  it('disabled → default provider', () => {
    assert.deepEqual(
      q.chooseCompanyLlmProvider({ requestedProviderId: 'b', providers, disabledProviderIds: new Set(['b']) }),
      { kind: 'fallback', providerId: 'd', requestedProviderId: 'b' },
    );
  });
  it('disabled and default also off → first enabled by name', () => {
    assert.deepEqual(
      q.chooseCompanyLlmProvider({ requestedProviderId: 'b', providers, disabledProviderIds: new Set(['b', 'd']) }),
      { kind: 'fallback', providerId: 'a', requestedProviderId: 'b' },
    );
  });
  it('none enabled → none', () => {
    assert.deepEqual(
      q.chooseCompanyLlmProvider({ requestedProviderId: 'b', providers, disabledProviderIds: new Set(['a', 'b', 'd']) }),
      { kind: 'none', requestedProviderId: 'b' },
    );
  });
  it('no provider / unknown provider keep the existing path', () => {
    assert.deepEqual(
      q.chooseCompanyLlmProvider({ requestedProviderId: null, providers, disabledProviderIds: new Set() }),
      { kind: 'unassigned' },
    );
    assert.deepEqual(
      q.chooseCompanyLlmProvider({ requestedProviderId: 'zzz', providers, disabledProviderIds: new Set() }),
      { kind: 'missing', requestedProviderId: 'zzz' },
    );
  });
});
