/**
 * CHAT-5: the thread's model choice is one metadata key, set or removed with a single UPDATE scoped
 * to (thread, resource, agent), with no read before the write.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const dialect = new PgDialect();
const executed: Array<{ sql: string; params: unknown[] }> = [];
let nextRows: unknown[] = [];

describe('CHAT-5 thread store: model choice', () => {
  let store: typeof import('./thread-store');

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: unknown, id: string) {
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
    Module.prototype.require = originalRequire;
  });

  beforeEach(() => {
    executed.length = 0;
    nextRows = [{ id: 't1' }];
  });

  const scope = { threadId: 't1', resourceId: 'company-c1:chat:free', agentId: 'a1' };

  it('set: one UPDATE writing the assistantModel key in place', async () => {
    assert.equal(await store.setAssistantThreadModelRow(scope, { providerId: 'p', modelId: 'm', reasoningLevel: 'low' }), true);
    assert.equal(executed.length, 1);
    const [{ sql, params }] = executed;
    assert.match(sql, /^UPDATE "mastra_threads" SET metadata = jsonb_set\(COALESCE\(metadata, '\{\}'::jsonb\), \$1::text\[\], \$2::jsonb, true\)/);
    assert.match(sql, /WHERE id = \$3 AND "resourceId" = \$4 AND metadata->>'agentId' = \$5 RETURNING id$/);
    assert.deepEqual(params, [
      '{assistantModel}',
      JSON.stringify({ providerId: 'p', modelId: 'm', reasoningLevel: 'low' }),
      't1',
      'company-c1:chat:free',
      'a1',
    ]);
    nextRows = [];
    assert.equal(await store.setAssistantThreadModelRow(scope, { providerId: 'p', modelId: 'm' }), false);
  });

  it('clear: one UPDATE removing the key', async () => {
    assert.equal(await store.setAssistantThreadModelRow(scope, null), true);
    const [{ sql, params }] = executed;
    assert.match(sql, /^UPDATE "mastra_threads" SET metadata = COALESCE\(metadata, '\{\}'::jsonb\) - \$1::text WHERE/);
    assert.deepEqual(params, ['assistantModel', 't1', 'company-c1:chat:free', 'a1']);
  });
});
