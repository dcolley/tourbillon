/**
 * Agent-level chat controller invalidation: cached chat controllers hold a tool snapshot, so
 * every agent mutator that changes what the agent may do must drop that agent's controllers
 * (and only that agent's). Real lib/agents.ts and the real controller cache; @tourbillon/db,
 * drizzle-orm and heavy runtime deps are stubbed (no DB, no model).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

type Row = Record<string, unknown>;
let row: Row;

const AGENT = 'agent-1';
const OTHER = 'agent-2';
const KEYS_FOR_AGENT = [`tourbillon-chat-${AGENT}`, `tourbillon-chat-${AGENT}:model-x`];
const KEY_FOR_OTHER = `tourbillon-chat-${OTHER}`;

describe('agent mutators invalidate that agent\'s cached chat controllers', () => {
  let agents: typeof import('../agents');
  let cache: typeof import('./controller-cache');
  let originalRequire: (id: string) => unknown;

  before(async () => {
    const Module = require('module');
    originalRequire = Module.prototype.require;
    const cachePath = path.resolve(__dirname, 'controller-cache.ts');
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      const fromAgents = this.filename?.endsWith('/lib/agents.ts');
      if (!fromAgents) return originalRequire.apply(this, arguments as unknown as [string]);
      if (id === '@tourbillon/db') {
        return {
          agents: { id: 'id', reportsToId: 'reportsToId' },
          companies: { id: 'id' },
          activityLog: {},
          db: {
            query: {
              agents: { findFirst: async () => ({ ...row }), findMany: async () => [] },
              companies: { findFirst: async () => ({ id: 'co-1', settings: {}, allowedMcpServerIds: [] }) },
            },
            update: () => ({
              set: (payload: Row) => ({
                where: () => ({
                  returning: async () => {
                    row = { ...row, ...payload };
                    return [{ ...row }];
                  },
                }),
              }),
            }),
            delete: () => ({ where: async () => undefined }),
            insert: () => ({ values: async () => undefined }),
          },
        };
      }
      if (id === 'drizzle-orm') return { eq: () => ({}), and: () => ({}) };
      if (id === '@tourbillon/mastra') return { clearIdleThreadOnRuntimeSwitch: async () => {} };
      // The real agent-level invalidation (what './chat' re-exports), on the real cache.
      if (id === './chat') return originalRequire.call(this, cachePath);
      if (id === './llm-providers') return { getDefaultLlmProviderRecord: async () => null };
      if (id === './company') return { getActiveCompany: async () => ({ id: 'co-1' }) };
      if (id === '@tourbillon/shared/company-workspace') {
        const real = originalRequire.apply(this, arguments as unknown as [string]) as Row;
        return { ...real, buildAssignedSkills: async () => ['control-plane'] };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    agents = await import('../agents');
    cache = await import('./controller-cache');
  });

  after(() => {
    const Module = require('module');
    Module.prototype.require = originalRequire;
  });

  beforeEach(() => {
    row = {
      id: AGENT,
      companyId: 'co-1',
      name: 'Agent One',
      urlKey: 'agent-one',
      role: 'engineer',
      status: 'active',
      assignedToolsets: [],
      assignedSkills: ['control-plane'],
      mcpServerIds: [],
      runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0 }, secrets: { API_TOKEN: 'fixture-not-real' } },
      updatedAt: new Date(0),
    };
    cache.clearChatControllerCache();
    for (const key of [...KEYS_FOR_AGENT, KEY_FOR_OTHER]) {
      cache.chatControllerCache().set(key, Promise.resolve({ key }));
      cache.chatControllerCompanies().set(key, 'co-1');
    }
  });

  function assertOnlyAgentDropped(label: string) {
    const keys = [...cache.chatControllerCache().keys()];
    for (const key of KEYS_FOR_AGENT) {
      assert.ok(!keys.includes(key), `${label}: ${key} dropped`);
      assert.ok(!cache.chatControllerCompanies().has(key), `${label}: ${key} company entry dropped`);
    }
    assert.ok(keys.includes(KEY_FOR_OTHER), `${label}: other agent's controller kept`);
  }

  it('invalidateChatControllerForAgent drops every controller of that agent (all model overrides) only', () => {
    cache.invalidateChatControllerForAgent(AGENT);
    assertOnlyAgentDropped('direct');
  });

  const cases: Array<[string, () => Promise<unknown>]> = [
    ['updateAgentAssignedToolsets', () => agents.updateAgentAssignedToolsets(AGENT, ['roster'])],
    ['updateAgentRuntimeConfig', () => agents.updateAgentRuntimeConfig(AGENT, { mail: { enabled: false } })],
    ['setAgentActiveWithOutcome', () => agents.setAgentActiveWithOutcome(AGENT, false)],
    ['updateAgentRole', () => agents.updateAgentRole(AGENT, 'ceo')],
    ['updateAgentSecrets', () => agents.updateAgentSecrets(AGENT, { secrets: { OTHER_TOKEN: 'fixture-two' } })],
    ['deleteAgentSecrets', () => agents.deleteAgentSecrets(AGENT, ['API_TOKEN'])],
    ['deleteAgent', () => agents.deleteAgent(AGENT, 'agent-one')],
  ];
  for (const [name, call] of cases) {
    it(`${name} drops the agent's cached chat controllers`, async () => {
      await call();
      assertOnlyAgentDropped(name);
    });
  }

  it('a refused change leaves cached controllers in place', async () => {
    await assert.rejects(() => agents.updateAgentAssignedToolsets(AGENT, ['no-such-toolset']));
    const keys = [...cache.chatControllerCache().keys()];
    for (const key of [...KEYS_FOR_AGENT, KEY_FOR_OTHER]) assert.ok(keys.includes(key), key);
  });
});
