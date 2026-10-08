/**
 * WC1 AC5: the enqueue-time payload carries the newest 20 comments (configurable through
 * opts.maxComments), oldest→newest. @tourbillon/db and ./issue-comments are faked; no DB.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

type Comment = { id: string; body: string; authorType: 'user' | 'agent' | 'system'; authorName: string; createdAt: string; action: string };
const comments: Comment[] = Array.from({ length: 25 }, (_, i) => ({
  id: `c${i + 1}`, body: `comment ${i + 1}`, authorType: i === 3 ? 'user' : 'agent', authorName: 'A',
  createdAt: new Date(Date.UTC(2026, 9, 7, 0, i)).toISOString(), action: 'issue.commented',
}));

describe('wake-payload: newest comments window', () => {
  let lib: typeof import('./wake-payload');

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      if (!this?.filename?.endsWith('wake-payload.ts')) return originalRequire.apply(this, arguments as unknown as [string]);
      if (id === '@tourbillon/db') {
        return {
          issues: { id: 'id' },
          agents: { id: 'id' },
          db: {
            query: {
              issues: {
                findFirst: async () => ({
                  id: 'task-1', companyId: 'co', identifier: 'TOUR-1', title: 'T', status: 'todo', priority: 'high', assigneeAgentId: 'a1',
                }),
              },
            },
          },
        };
      }
      if (id === 'drizzle-orm') return { eq: () => ({}) };
      if (id === './issue-comments') {
        return {
          listIssueComments: async (_i: string, _c: string, opts: { order?: string }) => {
            assert.equal(opts.order, 'desc');
            return { comments: [...comments].reverse(), latestId: 'c25' };
          },
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    lib = await import('./wake-payload');
  });

  it('defaults to the newest 20, ordered oldest→newest', async () => {
    const p = await lib.buildAssignmentWakePayload('task-1', 'co');
    assert.ok(p);
    assert.equal(p.newComments.length, 20);
    assert.equal(p.newComments[0].id, 'c6');
    assert.equal(p.newComments[19].id, 'c25');
    assert.equal(p.fallbackFetchNeeded, true);
  });

  it('opts.maxComments still overrides the window', async () => {
    const p = await lib.buildAssignmentWakePayload('task-1', 'co', { maxComments: 3 });
    assert.deepEqual(p?.newComments.map((c) => c.id), ['c23', 'c24', 'c25']);
  });
});
