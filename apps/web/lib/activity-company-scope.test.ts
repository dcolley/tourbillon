/**
 * S263-S2 (#263 softs): the chat_task title lookup in `loadActivityLookup` is company-scoped —
 * pinned against a real in-memory Postgres (PGlite), the way the Test gate wants it (M13 survived:
 * dropping `eq(chatTasks.companyId, companyId)` from that lookup left every suite green, which
 * would let a foreign task id render ANOTHER company's title in the Activity feed).
 *
 * Pattern borrowed from lib/assistant/feedback-store.test.ts: intercept the `@tourbillon/db`
 * require with the real module plus a PGlite-backed `db`, then drive the real loader + view.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused';

const dbRequire = createRequire(join(__dirname, '../../../packages/db/package.json'));
const { PGlite } = dbRequire('@electric-sql/pglite');
const { drizzle } = dbRequire('drizzle-orm/pglite');
const { readMigrationFiles } = dbRequire('drizzle-orm/migrator');
const MIGRATIONS = join(__dirname, '../../../packages/db/src/migrations');

type Entry = {
  id: string;
  companyId: string;
  actorType: string;
  actorId: string;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
  correlationId: string | null;
  createdAt: Date;
};

async function seededDb() {
  const client = new PGlite();
  for (const m of readMigrationFiles({ migrationsFolder: MIGRATIONS })) {
    for (const chunk of m.sql) {
      if (chunk.trim()) await client.exec(chunk);
    }
  }
  // Two companies; each owns one agent and one chat task. The foreign id is the M13 bait.
  await client.exec(`
    insert into companies (id, name, slug, issue_prefix) values
      ('c1', 'Bug Hunt', 'bug-hunt', 'BH'),
      ('c2', 'Other Co', 'other-co', 'OC');
    insert into agents (id, company_id, name, role, title, url_key) values
      ('a1', 'c1', 'Assistant', 'cto', 'The Assistant', 'assistant'),
      ('a2', 'c2', 'Rival', 'cto', 'The Rival', 'rival');
    insert into chat_tasks (id, company_id, agent_id, title) values
      ('t-home', 'c1', 'a1', 'Ship the runbook'),
      ('t-foreign', 'c2', 'a2', 'Rival secret plan');
  `);
  return { client, db: drizzle(client) };
}

function taskRow(entityId: string, over: Partial<Entry> = {}): Entry {
  return {
    id: `row-${entityId}`,
    companyId: 'c1',
    actorType: 'system',
    actorId: 'task-runner',
    actorName: 'Task runner',
    action: 'chat_task.queued',
    entityType: 'chat_task',
    entityId,
    details: {},
    correlationId: null,
    createdAt: new Date('2026-10-30T12:00:00.000Z'),
    ...over,
  };
}

describe('loadActivityLookup: chat_task title lookup is company-scoped (S263-S2, M13)', () => {
  it('a foreign chat_task id stays "Unknown task" — never another company\'s title', async () => {
    const { client, db } = await seededDb();
    try {
      const Module = require('module');
      const originalRequire = Module.prototype.require;
      Module.prototype.require = function (this: { filename?: string }, id: string) {
        if (id === '@tourbillon/db') {
          return { ...(originalRequire.apply(this, arguments as unknown as [string]) as object), db };
        }
        return originalRequire.apply(this, arguments as unknown as [string]);
      };
      let activity: typeof import('./activity');
      try {
        activity = await import('./activity');
      } finally {
        Module.prototype.require = originalRequire;
      }

      const entries = [taskRow('t-home'), taskRow('t-foreign')] as never;
      const lookup = await activity.loadActivityLookup('c1', entries);

      // M13 mutant (drop eq(chatTasks.companyId, companyId)): t-foreign resolves to
      // 'Rival secret plan' from company c2 → both assertions below go RED.
      assert.equal(lookup.chatTasks.get('t-home')?.title, 'Ship the runbook');
      assert.ok(!lookup.chatTasks.has('t-foreign'), 'a foreign id must not enter the lookup');

      const views = await activity.toActivityViews('c1', entries);
      const [home, foreign] = views;
      assert.equal(home!.item?.label, 'Ship the runbook');
      assert.equal(foreign!.item?.label, 'Unknown task', 'no leak of the other company\'s title');
      assert.equal(foreign!.item?.href, null);
    } finally {
      await client.close();
    }
  });
});
