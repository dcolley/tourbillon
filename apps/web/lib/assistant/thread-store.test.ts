/**
 * UI-2: the assistant thread store issues exactly one SQL statement per write, scoped to
 * (thread, resource, agent) or (user, company, agent), with no read before the write.
 * '@tourbillon/db' is replaced by a recorder; statements are rendered with drizzle's PG dialect.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const dialect = new PgDialect();
const executed: Array<{ sql: string; params: unknown[] }> = [];
let nextRows: unknown[] = [];

describe('UI-2 assistant thread store', () => {
  let store: typeof import('./thread-store');

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
              return nextRows;
            },
          },
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    store = await import('./thread-store');
  });

  beforeEach(() => {
    executed.length = 0;
    nextRows = [{ id: 't1', thread_id: 't1' }];
  });

  const scope = { threadId: 't1', resourceId: 'company-c1:chat:free', agentId: 'a1' };
  const pinScope = { userKey: 'u1', companyId: 'c1', agentId: 'a1' };

  it('rename: one UPDATE of the title, scoped to thread + resource + agent', async () => {
    assert.equal(await store.renameAssistantThreadRow(scope, 'New title'), true);
    assert.equal(executed.length, 1);
    const [{ sql, params }] = executed;
    assert.match(sql, /^UPDATE "mastra_threads" SET title = \$1,/);
    assert.doesNotMatch(sql, /metadata =|SELECT/);
    assert.match(sql, /WHERE id = \$2 AND "resourceId" = \$3 AND metadata->>'agentId' = \$4 RETURNING id$/);
    assert.deepEqual(params, ['New title', 't1', 'company-c1:chat:free', 'a1']);
    nextRows = [];
    assert.equal(await store.renameAssistantThreadRow(scope, 'x'), false, 'no row matched → false');
  });

  it('mark read: one UPDATE setting a single metadata key in place', async () => {
    assert.equal(await store.markAssistantThreadReadRow(scope, 'm9'), true);
    assert.equal(executed.length, 1);
    const [{ sql, params }] = executed;
    assert.match(sql, /^UPDATE "mastra_threads" SET metadata = jsonb_set\(COALESCE\(metadata, '\{\}'::jsonb\), \$1::text\[\], to_jsonb\(\$2::text\), true\)/);
    assert.doesNotMatch(sql, /title =/);
    assert.match(sql, /WHERE id = \$3 AND "resourceId" = \$4 AND metadata->>'agentId' = \$5/);
    assert.deepEqual(params, ['{assistantReadMessageId}', 'm9', 't1', 'company-c1:chat:free', 'a1']);
  });

  it('pin: one INSERT into the per-user table, capped per agent, idempotent', async () => {
    assert.equal(await store.pinAssistantThread(pinScope, 't1'), true);
    assert.equal(executed.length, 1);
    const [{ sql, params }] = executed;
    assert.match(sql, /^INSERT INTO assistant_thread_pins \(user_key, company_id, agent_id, thread_id\) SELECT/);
    assert.match(sql, /ON CONFLICT \(user_key, thread_id\) DO UPDATE/);
    assert.doesNotMatch(sql, /mastra_threads/);
    assert.deepEqual(params.slice(0, 4), ['u1', 'c1', 'a1', 't1']);
    assert.equal(params[params.length - 1], store.ASSISTANT_MAX_PINS_PER_AGENT);
    nextRows = [];
    assert.equal(await store.pinAssistantThread(pinScope, 't2'), false, 'cap reached → false');
  });

  it('unpin and list are scoped to user + company + agent', async () => {
    await store.unpinAssistantThread(pinScope, 't1');
    nextRows = [{ thread_id: 'b' }, { thread_id: 'a' }];
    assert.deepEqual(await store.listPinnedAssistantThreadIds(pinScope), ['b', 'a']);
    assert.equal(executed.length, 2);
    assert.match(executed[0].sql, /^DELETE FROM assistant_thread_pins WHERE user_key = \$1 AND company_id = \$2 AND agent_id = \$3 AND thread_id = \$4$/);
    assert.deepEqual(executed[0].params, ['u1', 'c1', 'a1', 't1']);
    assert.match(executed[1].sql, /^SELECT thread_id FROM assistant_thread_pins WHERE user_key = \$1 AND company_id = \$2 AND agent_id = \$3 ORDER BY created_at DESC LIMIT \$4$/);
  });
});
