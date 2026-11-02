/**
 * S297-S3: updateAgentRuntimeConfigKeys against a real Postgres (PGlite, in memory) with the
 * repo's migrations applied. Pins the three things the web-side mocks cannot: (1) the jsonb
 * merge semantics — a per-key write never drops a key another writer committed meanwhile,
 * (2) stored shapes byte-identical to the whole-object writes they replace (compare
 * `runtime_config::text`), and (3) the update is ONE statement (driver-boundary spy).
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { sql, eq } from 'drizzle-orm';

process.env.DATABASE_URL ??= 'postgres://user:***@127.0.0.1:5432/unused';

const MIGRATIONS = path.join(__dirname, 'migrations');

async function migrateUp(client: PGlite): Promise<void> {
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
}

type Schema = typeof import('./schema/index');
type Helpers = typeof import('./agent-runtime-config');

const HEARTBEAT = { enabled: false, intervalSec: 0, scheduleMode: 'interval', wakeOnAssignment: true, wakeOnDemand: true };
const AVATAR = { shape: 'blob-2', color: '#8b5cf6' };
const MODEL = { temperature: 0.3 };

describe('S297-S3 updateAgentRuntimeConfigKeys (PGlite, real jsonb semantics)', () => {
  let schema: Schema;
  let helpers: Helpers;
  let client: PGlite;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let database: any;

  before(async () => {
    schema = await import('./schema/index');
    helpers = await import('./agent-runtime-config');
    client = new PGlite();
    await migrateUp(client);
    database = drizzle(client, { schema });
  });

  after(async () => {
    await client.close();
  });

  beforeEach(async () => {
    await database.execute(sql`delete from agents`);
    await database.execute(sql`delete from companies`);
    await database.insert(schema.companies).values({ id: 'co-a', name: 'Alpha', slug: 'alpha', issuePrefix: 'ALP' });
  });

  async function seedAgent(id: string, runtimeConfig: unknown, adapterConfig: unknown = {}): Promise<void> {
    await database
      .insert(schema.agents)
      .values({ id, companyId: 'co-a', name: id, title: id, role: 'engineer', urlKey: id, runtimeConfig, adapterConfig });
  }

  async function stored(id: string): Promise<Record<string, unknown>> {
    const res = await database.execute(
      sql`select runtime_config from agents where id = ${id}`,
    );
    return (res as { rows: { runtime_config: Record<string, unknown> }[] }).rows[0].runtime_config;
  }

  async function storedText(id: string): Promise<string> {
    const res = await database.execute(
      sql`select runtime_config::text as t from agents where id = ${id}`,
    );
    return (res as { rows: { t: string }[] }).rows[0].t;
  }

  it('setting one key never drops a concurrently-committed other key (interleaved writes)', async () => {
    const BASE = { heartbeat: HEARTBEAT, timeout: { heartbeatSec: 300, graceSec: 30 } };
    await seedAgent('a-1', structuredClone(BASE));

    // Writer A reads the row (document snapshot in hand)…
    const snapshot = structuredClone(BASE);
    // …writer B then COMMITS an avatar change to the live row…
    await helpers.updateAgentRuntimeConfigKeys('a-1', { set: { avatar: AVATAR } }, {}, database);
    // …writer A now writes back, atomically, only the key it owns. Its stale snapshot is
    // irrelevant: Postgres merges onto the live document.
    const updated = await helpers.updateAgentRuntimeConfigKeys(
      'a-1',
      { set: { model: { temperature: 0.9 } } },
      { updatedAt: new Date() },
      database,
    );
    assert.ok(updated);
    const doc = await stored('a-1');
    assert.deepEqual(doc.avatar, AVATAR, 'concurrently committed avatar survived');
    assert.deepEqual(doc.model, { temperature: 0.9 });
    assert.deepEqual(doc.heartbeat, HEARTBEAT);
    // The stale snapshot writer A held would have erased the avatar (whole-object rewrite):
    assert.notDeepEqual(doc, { ...snapshot, model: { temperature: 0.9 } });
    assert.equal('avatar' in { ...snapshot, model: { temperature: 0.9 } }, false, 'the snapshot indeed lacked the avatar');

    // Mirror direction: clear one key, keep a concurrently-set model.
    await seedAgent('a-2', { heartbeat: HEARTBEAT, avatar: { shape: 'circle', color: '#000' } });
    await helpers.updateAgentRuntimeConfigKeys('a-2', { set: { model: MODEL } }, {}, database);
    const cleared = await helpers.updateAgentRuntimeConfigKeys('a-2', { clear: ['avatar'] }, {}, database);
    assert.ok(cleared);
    const doc2 = await stored('a-2');
    assert.equal('avatar' in doc2, false);
    assert.deepEqual(doc2.model, MODEL, 'concurrent model write survived the avatar clear');
  });

  it('stored shapes are byte-identical to the whole-object writes they replace', async () => {
    const BASE = { heartbeat: HEARTBEAT, timeout: { heartbeatSec: 300, graceSec: 30 }, model: MODEL };
    await seedAgent('b-via-ops', structuredClone(BASE));
    await seedAgent('b-via-whole', structuredClone(BASE));
    await seedAgent('b-clear-ops', { ...structuredClone(BASE), avatar: AVATAR });
    await seedAgent('b-clear-whole', { ...structuredClone(BASE), avatar: AVATAR });

    // set path: ops merge of `avatar` vs a whole-document write of the expected result.
    await helpers.updateAgentRuntimeConfigKeys('b-via-ops', { set: { avatar: AVATAR } }, {}, database);
    await database
      .update(schema.agents)
      .set({ runtimeConfig: { ...structuredClone(BASE), avatar: AVATAR } })
      .where(eq(schema.agents.id, 'b-via-whole'));

    // clear path: `- 'avatar'` vs a whole-document write without the key.
    await helpers.updateAgentRuntimeConfigKeys('b-clear-ops', { clear: ['avatar'] }, {}, database);
    await database
      .update(schema.agents)
      .set({ runtimeConfig: structuredClone(BASE) })
      .where(eq(schema.agents.id, 'b-clear-whole'));

    assert.equal(await storedText('b-via-ops'), await storedText('b-via-whole'), 'set path diverged');
    assert.equal(await storedText('b-clear-ops'), await storedText('b-clear-whole'), 'clear path diverged');
  });

  it('multi-key ops, clears and extra columns land in ONE UPDATE statement', async () => {
    const { spyQueries } = await import('./test/query-spy');
    await seedAgent('c-1', { heartbeat: HEARTBEAT, tavilyApiKey: 'secret', avatar: AVATAR });

    const captured = spyQueries(client);
    const before = captured.length;
    const updated = await helpers.updateAgentRuntimeConfigKeys(
      'c-1',
      { set: { model: MODEL, assignedTools: ['createIssue'] }, clear: ['tavilyApiKey'] },
      { updatedAt: new Date() },
      database,
    );
    assert.ok(updated);
    const updates = captured.slice(before).filter((q) => /^\s*update/i.test(q.sql));
    assert.equal(updates.length, 1, `exactly one UPDATE, got ${updates.length}: ${updates.map((u) => u.sql).join(' | ')}`);
    assert.match(updates[0].sql, /jsonb_build_object/, 'set merge uses jsonb_build_object');
    assert.match(updates[0].sql, /-\s*\$\d+::text/, 'clear uses the jsonb `-` operator with a bound key');
    assert.match(updates[0].sql, /\|\|/, 'set merge uses the jsonb `||` merge');
    const params = updates[0].params.map((p) => (typeof p === 'string' ? p : JSON.stringify(p)));
    assert.ok(params.includes('tavilyApiKey'), 'clear key is a bound parameter (never interpolated)');
    assert.ok(params.includes('model') && params.includes(JSON.stringify(MODEL)), 'set key/value bound');
    assert.ok(params.includes('assignedTools') && params.includes(JSON.stringify(['createIssue'])), 'set key/value bound');

    const doc = await stored('c-1');
    assert.deepEqual(doc.model, MODEL);
    assert.deepEqual(doc.assignedTools, ['createIssue']);
    assert.equal('tavilyApiKey' in doc, false);
    assert.deepEqual(doc.avatar, AVATAR, 'untouched key kept byte-identical');
  });

  it('missing agent → null, no throw; guards reject malformed ops without touching the db', async () => {
    assert.equal(await helpers.updateAgentRuntimeConfigKeys('nope', { set: { avatar: AVATAR } }, {}, database), null);
    assert.throws(() => helpers.buildRuntimeConfigKeyMerge({ set: { a: undefined } }), /pass it in `clear` instead/);
    assert.throws(() => helpers.buildRuntimeConfigKeyMerge({ set: { a: 1 }, clear: ['a'] }), /both set and cleared/);
    assert.throws(() => helpers.buildRuntimeConfigKeyMerge({}), /nothing to do/);
    assert.throws(() => helpers.buildRuntimeConfigKeyMerge({ set: { '': 1 } }), /empty key/);
    assert.throws(() => helpers.buildRuntimeConfigKeyMerge({ clear: ['x', 'x'] }), /duplicate clear/);
  });

  it('clearing a key that is absent is a no-op on the stored bytes', async () => {
    const BASE = { heartbeat: HEARTBEAT };
    await seedAgent('d-1', structuredClone(BASE));
    const beforeText = await storedText('d-1');
    await helpers.updateAgentRuntimeConfigKeys('d-1', { clear: ['avatar'] }, {}, database);
    assert.equal(await storedText('d-1'), beforeText);
  });

  it('S306-S1: set OVERWRITES an existing key — set wins over the live document', async () => {
    // Mutant f (swap the operands of `||` so the live document wins over
    // jsonb_build_object) survives the rest of this suite: every set above targets a key the
    // seeded doc does NOT have, where live-wins and set-wins are indistinguishable. This pins
    // the overwrite case: set { avatar: B } on a row already storing avatar A → B, exactly.
    const AVATAR_B = { shape: 'circle', color: '#10b981' }; // valid AgentAvatarConfig, ≠ AVATAR
    assert.notDeepEqual(AVATAR_B, AVATAR);
    await seedAgent('e-1', { heartbeat: HEARTBEAT, avatar: structuredClone(AVATAR) });

    const updated = await helpers.updateAgentRuntimeConfigKeys('e-1', { set: { avatar: AVATAR_B } }, {}, database);
    if (!updated) throw new Error('update returned no row');

    const doc = await stored('e-1');
    assert.deepEqual(doc.avatar, AVATAR_B, 'stored avatar is exactly B');
    assert.notDeepEqual(doc.avatar, AVATAR, 'seeded avatar A is gone (no live-wins merge)');
    assert.deepEqual(doc.heartbeat, HEARTBEAT, 'untouched keys survive');
    // The RETURNING row reflects the post-merge document too.
    assert.deepEqual((updated.runtimeConfig as Record<string, unknown>).avatar, AVATAR_B);
  });
});
