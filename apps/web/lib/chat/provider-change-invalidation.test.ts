/**
 * Chat controller cache invalidation on LLM provider registry changes: agents without their
 * own provider resolve to the registry default, so changing the default (or editing / deleting
 * a provider) must make the next chat call build a fresh controller.
 * DB, company lookup and the chat runtime are stubbed: no real DB or model.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

type Row = Record<string, unknown>;
let rows: Row[] = [];
let builds = 0;
const builtWith: Array<string | null> = [];

const provider = (over: Row = {}): Row => ({
  id: 'prov-a', name: 'A', type: 'openai', baseURL: 'https://a.test/v1', apiKey: null,
  headers: {}, apiMode: 'chat', defaultModelSettings: {}, defaultModel: null,
  isDefault: false, stickiness: 'off', stickinessHeaderName: 'x-litellm-session-id',
  createdAt: new Date(0), updatedAt: new Date(0), ...over,
});

const agentRow = (over: Row = {}) =>
  ({ id: 'agent-1', companyId: 'co-1', providerId: null, runtimeConfig: {}, ...over }) as never;

function applySet(target: (r: Row) => boolean, v: Row) {
  rows = rows.map((r) => (target(r) ? { ...r, ...v } : r));
}

describe('chat controllers follow LLM provider registry changes', () => {
  let providers: typeof import('../llm-providers');
  let registry: typeof import('./registry');
  let cache: typeof import('./controller-cache');
  let originalRequire: (id: string) => unknown;

  before(async () => {
    const Module = require('module');
    originalRequire = Module.prototype.require;
    const stubs: Record<string, unknown> = {
      '@tourbillon/db': {
        llmProviders: { id: 'id', isDefault: 'isDefault' },
        agents: { providerId: 'providerId', id: 'id', companyId: 'companyId', urlKey: 'urlKey' },
        companies: { id: 'id' },
        listLlmProviderRows: async () => rows,
        getLlmProviderRowById: async (rid: string) => rows.find((r) => r.id === rid) ?? null,
        getDefaultLlmProviderRow: async () => rows.find((r) => r.isDefault) ?? null,
        db: {
          query: {
            agents: { findMany: async () => [], findFirst: async () => null },
            companies: { findFirst: async () => ({ id: 'co-1', allowedMcpServerIds: [], settings: {} }) },
          },
          insert: () => ({
            values: (v: Row) => {
              const created = provider({ ...v, id: `prov-${rows.length + 1}` });
              rows.push(created);
              return { returning: async () => [created] };
            },
          }),
          // where(cond) carries the target id through the drizzle-orm stubs below.
          update: () => ({
            set: (v: Row) => ({
              where: (cond: { op: string; id: string }) => {
                const match = (r: Row) => (cond?.op === 'ne' ? r.id !== cond.id : r.id === cond?.id);
                applySet(match, v);
                const p = Promise.resolve(undefined) as Promise<undefined> & { returning: () => Promise<Row[]> };
                p.returning = async () => rows.filter(match);
                return p;
              },
              then: (resolve: (v: unknown) => void) => {
                applySet(() => true, v);
                resolve(undefined);
              },
            }),
          }),
          delete: () => ({
            where: async (cond: { id: string }) => {
              rows = rows.filter((r) => r.id !== cond.id);
            },
          }),
        },
      },
      'drizzle-orm': {
        eq: (_col: unknown, id: string) => ({ op: 'eq', id }),
        ne: (_col: unknown, id: string) => ({ op: 'ne', id }),
        and: (...c: unknown[]) => c[0],
      },
      '@/lib/company': { getActiveCompany: async () => ({ id: 'co-1' }) },
      '@/lib/auth/chat-token': { buildChatScopedApiKey: () => 'k', validateChatToken: () => null },
      '@tourbillon/shared/agent-token': { chatSessionIdForAgent: (id: string) => `chat-${id}` },
    };
    const chatRuntime = {
      createChatController: async () => {
        builds += 1;
        // What a fresh controller would resolve for an agent with no provider of its own.
        const def = rows.find((r) => r.isDefault);
        builtWith.push(def ? String(def.id) : null);
        return { id: `controller-${builds}`, init: async () => {} };
      },
      buildChatResourceId: (companyId: string) => `chat:${companyId}`,
      buildChatControllerId: (agentId: string, modelId?: string) =>
        modelId ? `tourbillon-chat-${agentId}:${modelId}` : `tourbillon-chat-${agentId}`,
      createHeartbeatRuntimeContext: () => ({}),
    };
    Module.prototype.require = function (id: string) {
      if (id in stubs) return stubs[id];
      if (id.endsWith('packages/mastra/src/chat')) return chatRuntime;
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    providers = await import('../llm-providers');
    registry = await import('./registry');
    cache = await import('./controller-cache');
  });

  after(() => {
    const Module = require('module');
    Module.prototype.require = originalRequire;
  });

  beforeEach(() => {
    cache.clearChatControllerCache();
    builds = 0;
    builtWith.length = 0;
    rows = [provider({ id: 'prov-a', isDefault: true }), provider({ id: 'prov-b', name: 'B' })];
  });

  it('reuses the cached controller while the registry is unchanged', async () => {
    const first = await registry.getOrCreateChatController(agentRow());
    const second = await registry.getOrCreateChatController(agentRow());
    assert.equal(first, second);
    assert.equal(builds, 1);
  });

  it('changing the default provider makes the next chat call build a fresh controller', async () => {
    const before = await registry.getOrCreateChatController(agentRow());
    assert.deepEqual(builtWith, ['prov-a']);

    await providers.updateLlmProvider('prov-b', { isDefault: true });
    assert.equal(rows.find((r) => r.isDefault)?.id, 'prov-b');

    const afterChange = await registry.getOrCreateChatController(agentRow());
    assert.notEqual(afterChange, before);
    assert.equal(builds, 2);
    assert.deepEqual(builtWith, ['prov-a', 'prov-b']);
  });

  it('editing a provider invalidates cached controllers', async () => {
    const before = await registry.getOrCreateChatController(agentRow());
    await providers.updateLlmProvider('prov-a', { name: 'A renamed' });
    const afterEdit = await registry.getOrCreateChatController(agentRow());
    assert.notEqual(afterEdit, before);
    assert.equal(builds, 2);
  });

  it('deleting a provider invalidates cached controllers', async () => {
    const before = await registry.getOrCreateChatController(agentRow());
    await providers.deleteLlmProvider('prov-a');
    assert.equal(rows.find((r) => r.isDefault)?.id, 'prov-b');
    const afterDelete = await registry.getOrCreateChatController(agentRow());
    assert.notEqual(afterDelete, before);
    assert.deepEqual(builtWith, ['prov-a', 'prov-b']);
  });

  it('creating a new default provider invalidates controllers of every company', async () => {
    await registry.getOrCreateChatController(agentRow());
    await registry.getOrCreateChatController(agentRow({ id: 'agent-2', companyId: 'co-2' }));
    assert.equal(builds, 2);
    await providers.createLlmProvider({ name: 'C', type: 'openai', baseURL: 'https://c.test/v1', isDefault: true });
    await registry.getOrCreateChatController(agentRow());
    await registry.getOrCreateChatController(agentRow({ id: 'agent-2', companyId: 'co-2' }));
    assert.equal(builds, 4);
  });

  it('a failed provider update leaves cached controllers in place', async () => {
    const before = await registry.getOrCreateChatController(agentRow());
    await assert.rejects(providers.updateLlmProvider('prov-missing', { isDefault: true }));
    assert.equal(await registry.getOrCreateChatController(agentRow()), before);
    assert.equal(builds, 1);
  });
});
