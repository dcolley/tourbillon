/**
 * runs-follow-default: mastra chat (createChatAgentWithSkills) and the harness model resolve the
 * LLM provider as agent → registry default → env, and an agent adapterConfig.baseURL on another
 * host from that provider never gets the provider's key/headers (ProviderConfigError
 * llm_provider_base_url_host_mismatch, 409) while a same-host override still does.
 * Mocked via Module.prototype.require: @tourbillon/db and @ai-sdk/openai for provider.ts (the
 * latter captures baseURL/apiKey/headers instead of building a client), and the chat controller's
 * tool/skill/memory/Agent dependencies. No DB, no network.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent as AgentRecord } from '@tourbillon/db';

type Row = Record<string, unknown>;
type ModelOpts = { baseURL: string; apiKey: string; headers: Record<string, string> };
type FakeModel = { kind: string; id: string; opts: ModelOpts };

const DEFAULT_KEY = 'sk-registry-default-key-0123456789';
const OWN_KEY = 'sk-own-provider-key-0123456789';
const ENV_KEYS = ['LLM_PROVIDER', 'LLM_BASE_URL', 'LM_STUDIO_BASE_URL', 'LM_STUDIO_API_KEY', 'LLM_API_KEY'] as const;
const env = process.env as Record<string, string | undefined>;
const savedEnv: Record<string, string | undefined> = {};

let providers: Row[] = [];
const lookups: string[] = [];
const builtAgents: Array<{ model: FakeModel }> = [];

const providerRow = (over: Row = {}): Row => ({
  id: 'prov-default', name: 'Registry Default', type: 'openai-compatible', baseURL: 'http://gw.test:8000/v1',
  apiKey: DEFAULT_KEY, headers: { 'X-Team-Token': 'team-secret' }, apiMode: 'chat', isDefault: true,
  defaultModelSettings: {}, defaultModel: null, stickiness: 'off', stickinessHeaderName: 'x-litellm-session-id',
  ...over,
});
const agentRecord = (over: Partial<AgentRecord> = {}): AgentRecord =>
  ({
    id: 'agent-1', companyId: 'co-1', name: 'Alice', urlKey: 'alice', role: 'engineer', title: 'Eng',
    adapterType: 'lmstudio', adapterConfig: {}, modelId: 'model-x', providerId: null, runtimeConfig: {},
    instructionsBundleAgentsMd: null, instructionsBundleSoulMd: null, ...over,
  }) as unknown as AgentRecord;

describe('mastra chat provider resolution', () => {
  let createChatAgentWithSkills: typeof import('./chat-controller').createChatAgentWithSkills;
  let getLanguageModelForAgent: typeof import('./provider').getLanguageModelForAgent;
  let resolveAgentProviderRecord: typeof import('./provider').resolveAgentProviderRecord;

  before(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = env[k];
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      const file = this?.filename ?? '';
      if (file.endsWith('/provider.ts') && id === '@tourbillon/db') {
        return {
          getLlmProviderRowById: async (pid: string) => {
            lookups.push(`byId:${pid}`);
            return providers.find((p) => p.id === pid) ?? null;
          },
          getDefaultLlmProviderRow: async () => {
            lookups.push('default');
            return providers.find((p) => p.isDefault) ?? null;
          },
        };
      }
      if (file.endsWith('/provider.ts') && id === '@ai-sdk/openai') {
        return {
          createOpenAI: (opts: ModelOpts) => {
            const p = ((mid: string) => ({ kind: 'responses', id: mid, opts })) as unknown as Row;
            p.chat = (mid: string) => ({ kind: 'chat', id: mid, opts });
            p.embedding = (mid: string) => ({ kind: 'embedding', id: mid, opts });
            return p;
          },
        };
      }
      if (file.endsWith('/chat-controller.ts')) {
        if (id === './agent-factory') {
          return { assembleAgentTools: async () => ({}), getAgentMemory: async () => undefined };
        }
        if (id === './skills/on-demand-skills') {
          return {
            prepareAgentSkills: async () => ({ alwaysInline: [], catalog: [] }),
            formatChatSkillsCatalogSection: () => '',
          };
        }
        if (id === '@mastra/core/agent') {
          return {
            Agent: class {
              constructor(opts: { model: FakeModel }) {
                builtAgents.push(opts);
              }
            },
          };
        }
        if (id === '@mastra/core/agent-controller') return { AgentController: class {} };
        if (id === '@mastra/pg') return { PostgresStore: class {} };
        if (id === './heartbeat-processors') return { buildHeartbeatInputProcessors: () => [] };
        if (id === './mastra-instance') return { getMastraInstance: () => ({}) };
        if (id === './execution-workspace') return { buildChatWorkspace: () => ({}) };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ createChatAgentWithSkills } = await import('./chat-controller'));
    ({ getLanguageModelForAgent, resolveAgentProviderRecord } = await import('./provider'));
    Module.prototype.require = originalRequire;
  });

  after(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete env[k];
      else env[k] = savedEnv[k];
    }
  });

  beforeEach(() => {
    for (const k of ENV_KEYS) delete env[k];
    providers = [];
    lookups.length = 0;
    builtAgents.length = 0;
  });

  const chatModel = async (over: Partial<AgentRecord> = {}): Promise<FakeModel> => {
    await createChatAgentWithSkills(agentRecord(over));
    assert.equal(builtAgents.length, 1);
    return builtAgents[0].model;
  };

  it("chat: agent with its own provider → that provider's URL and key (default not read)", async () => {
    providers = [providerRow(), providerRow({ id: 'prov-own', name: 'Own', baseURL: 'http://own.test/v1', apiKey: OWN_KEY, isDefault: false })];
    const model = await chatModel({ providerId: 'prov-own' });
    assert.equal(model.opts.baseURL, 'http://own.test/v1');
    assert.equal(model.opts.apiKey, OWN_KEY);
    assert.ok(lookups.length > 0 && lookups.every((l) => l === 'byId:prov-own'), String(lookups));
  });

  it('chat: agent without a provider → registry default (was: env)', async () => {
    providers = [providerRow()];
    env.LM_STUDIO_BASE_URL = 'http://lm.env.test/v1';
    const model = await chatModel();
    assert.equal(model.opts.baseURL, 'http://gw.test:8000/v1');
    assert.equal(model.opts.apiKey, DEFAULT_KEY);
    assert.equal(model.opts.headers['X-Team-Token'], 'team-secret');
  });

  it("chat: agent's provider row is gone → registry default", async () => {
    providers = [providerRow()];
    const model = await chatModel({ providerId: 'prov-deleted' });
    assert.equal(model.opts.baseURL, 'http://gw.test:8000/v1');
    assert.deepEqual(lookups.slice(0, 2), ['byId:prov-deleted', 'default']);
  });

  it('chat: no agent provider and no registry default → env', async () => {
    providers = [providerRow({ isDefault: false })];
    env.LM_STUDIO_BASE_URL = 'http://lm.env.test/v1';
    env.LM_STUDIO_API_KEY = 'env-lm-key';
    const model = await chatModel();
    assert.equal(model.opts.baseURL, 'http://lm.env.test/v1');
    assert.equal(model.opts.apiKey, 'env-lm-key');
  });

  it('chat: adapterConfig.baseURL on another host → llm_provider_base_url_host_mismatch (409), no model built', async () => {
    providers = [providerRow()];
    await assert.rejects(
      createChatAgentWithSkills(agentRecord({ adapterConfig: { baseURL: 'http://elsewhere.test/v1' } })),
      (err: unknown) => {
        const e = err as { code?: string; status?: number; message: string };
        assert.equal(e.code, 'llm_provider_base_url_host_mismatch');
        assert.equal(e.status, 409);
        assert.ok(!e.message.includes(DEFAULT_KEY));
        return true;
      },
    );
    assert.equal(builtAgents.length, 0);
  });

  it('chat: same-host adapterConfig.baseURL override still gets the provider key and headers', async () => {
    providers = [providerRow()];
    const model = await chatModel({ adapterConfig: { baseURL: 'http://gw.test:8000/v2' } });
    assert.equal(model.opts.baseURL, 'http://gw.test:8000/v2');
    assert.equal(model.opts.apiKey, DEFAULT_KEY);
    assert.equal(model.opts.headers['X-Team-Token'], 'team-secret');
  });

  it('heartbeat model (getLanguageModelForAgent, used by the harness controller) refuses the host mismatch too', async () => {
    providers = [providerRow()];
    const { record } = await resolveAgentProviderRecord({ providerId: null });
    assert.equal(record?.id, 'prov-default');
    assert.throws(
      () => getLanguageModelForAgent(agentRecord({ adapterConfig: { baseURL: 'http://elsewhere.test/v1' } }), record),
      /llm_provider_base_url_host_mismatch|different host/,
    );
    const model = getLanguageModelForAgent(agentRecord({ adapterConfig: { baseURL: 'http://gw.test:8000/v2' } }), record) as unknown as FakeModel;
    assert.equal(model.opts.apiKey, DEFAULT_KEY);
  });
});
