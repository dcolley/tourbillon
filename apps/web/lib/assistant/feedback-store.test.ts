/**
 * OBS-2: a reaction is one UPDATE of the thread's metadata, scoped to (thread, resource, agent),
 * with no read before the write. '@tourbillon/db' is replaced by a recorder (as in thread-store.test.ts);
 * the same statements are also run on PGlite (Postgres in-process) to check the jsonb merge.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const dbRequire = createRequire(join(__dirname, '../../../../packages/db/package.json'));

const dialect = new PgDialect();
const executed: Array<{ sql: string; params: unknown[] }> = [];
let nextRows: unknown[] = [];
/** When set, statements run on this PGlite instance instead of the recorder. */
let pg: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>; exec: (sql: string) => Promise<unknown> } | null = null;

describe('OBS-2 feedback store', () => {
  let store: typeof import('./feedback-store');

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      if (id === '@tourbillon/db') {
        return {
          db: {
            execute: async (q: SQL) => {
              const { sql, params } = dialect.sqlToQuery(q);
              executed.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
              if (pg) return (await pg.query(sql, params)).rows;
              return nextRows;
            },
          },
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    store = await import('./feedback-store');
  });

  beforeEach(() => {
    executed.length = 0;
    nextRows = [{ id: 't1' }];
    pg = null;
  });

  const scope = { threadId: 't1', resourceId: 'company-c1:chat:free', agentId: 'a1' };
  const entry = { rating: 'down' as const, reason: 'wrong', tags: ['incorrect' as const], updatedAt: '2026-10-25T00:00:00.000Z' };

  it('one scoped UPDATE that sets only this user’s entry for this message', async () => {
    assert.equal(await store.saveAssistantMessageFeedbackRow(scope, 'm1', 'u1', entry), true);
    assert.equal(executed.length, 1);
    const [{ sql, params }] = executed;
    assert.match(sql, /^UPDATE "mastra_threads" SET metadata = jsonb_set\(COALESCE\(metadata, '\{\}'::jsonb\),/);
    assert.match(sql, /WHERE id = \$\d+ AND "resourceId" = \$\d+ AND metadata->>'agentId' = \$\d+ RETURNING id$/);
    assert.doesNotMatch(sql, /SELECT/);
    assert.ok(params.includes('{assistantFeedback}'));
    assert.ok(params.includes('m1'));
    assert.ok(params.includes('u1'));
    assert.ok(params.includes(JSON.stringify(entry)));
    assert.deepEqual(params.slice(-3), ['t1', 'company-c1:chat:free', 'a1']);
  });

  it('returns false when no thread matched the scope', async () => {
    nextRows = [];
    assert.equal(await store.saveAssistantMessageFeedbackRow(scope, 'm1', 'u1', entry), false);
  });

  it('on Postgres: replaces one user’s entry per message, keeps other users, messages and metadata', async () => {
    const { PGlite } = dbRequire('@electric-sql/pglite');
    pg = new PGlite();
    await pg!.exec(`CREATE TABLE mastra_threads (id text PRIMARY KEY, "resourceId" text, title text, metadata jsonb);
      INSERT INTO mastra_threads VALUES
        ('t1', 'company-c1:chat:free', 'T', '{"agentId":"a1","assistantReadMessageId":"m0"}'),
        ('t2', 'company-c1:chat:free', 'T', '{"agentId":"a1","assistantFeedback":"not an object"}');`);
    const up = { ...entry, rating: 'up' as const, reason: null, tags: [] };
    assert.equal(await store.saveAssistantMessageFeedbackRow(scope, 'm1', 'u1', up), true);
    assert.equal(await store.saveAssistantMessageFeedbackRow(scope, 'm1', 'u1', entry), true);
    assert.equal(await store.saveAssistantMessageFeedbackRow(scope, 'm1', 'u2', up), true);
    assert.equal(await store.saveAssistantMessageFeedbackRow(scope, 'm2', 'u1', up), true);
    assert.equal(await store.saveAssistantMessageFeedbackRow({ ...scope, agentId: 'a2' }, 'm1', 'u1', up), false);
    assert.equal(await store.saveAssistantMessageFeedbackRow({ ...scope, resourceId: 'company-c2:chat:free' }, 'm1', 'u1', up), false);
    assert.equal(await store.saveAssistantMessageFeedbackRow({ ...scope, threadId: 't2' }, 'm1', 'u1', up), true);

    const rows = (await pg!.query('SELECT id, metadata FROM mastra_threads ORDER BY id', [])).rows as Array<{ id: string; metadata: any }>;
    assert.deepEqual(rows[0].metadata, {
      agentId: 'a1',
      assistantReadMessageId: 'm0',
      assistantFeedback: { m1: { u1: entry, u2: up }, m2: { u1: up } },
    });
    assert.deepEqual(rows[1].metadata, { agentId: 'a1', assistantFeedback: { m1: { u1: up } } });
  });
});
