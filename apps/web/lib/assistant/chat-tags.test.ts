/**
 * UI-2: metadata the assistant view writes on a thread stays out of the chat pane's thread tags
 * (the chat pane filters and labels threads by these tags).
 * Storage and the Mastra chat module are stubbed; only the tag helpers are exercised.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

describe('UI-2 assistant metadata vs chat thread tags', () => {
  let registry: typeof import('../chat/registry');
  let sidebar: typeof import('./sidebar');

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      if (id === '@tourbillon/db') return { db: {}, agents: {}, companies: {} };
      if (id.endsWith('packages/mastra/src/chat')) return {};
      if (id === '@/lib/company') return { getActiveCompany: async () => ({ id: 'c' }) };
      if (id === '@/lib/auth/chat-token') return {};
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    registry = await import('../chat/registry');
    sidebar = await import('./sidebar');
  });

  it('every assistant metadata key is reserved and dropped from tags', () => {
    for (const key of sidebar.ASSISTANT_THREAD_METADATA_KEYS) {
      assert.equal(registry.isReservedThreadMetadataKey(key), true, key);
    }
    const tags = registry.extractThreadTags({
      kind: 'chat',
      contextType: 'free',
      agentId: 'agent-a',
      [sidebar.ASSISTANT_THREAD_READ_MESSAGE_KEY]: 'msg-1',
    });
    assert.deepEqual(tags, { kind: 'chat', contextType: 'free', agentId: 'agent-a' });
  });

  it('ordinary tags are still kept', () => {
    assert.equal(registry.isReservedThreadMetadataKey('contextType'), false);
    assert.deepEqual(registry.extractThreadTags({ contextId: '7', currentModelId: 'm' }), { contextId: '7' });
  });
});
