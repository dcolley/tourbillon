/**
 * runs-follow-default: the wake-runner resolves the LLM provider as agent → registry default
 * (the same `is_default` row /api/models lists) → env, and refuses (run failed,
 * llm_provider_base_url_host_mismatch) when an agent adapterConfig.baseURL on another host
 * would receive the provider's key/headers. The resolved provider is recorded on the run's
 * contextSnapshot (providerId, providerSource, providerName).
 * @tourbillon/db, drizzle-orm, ./redis-pub and ./adapters/harness-adapter are mocked via
 * Module.prototype.require (for wake-runner.ts only): no database, Redis or LLM is touched.
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const SECRET = 'test-agent-token-secret-rfd-0123456789abcdef';
const KEY = 'sk-registry-default-key-0123456789';
const env = process.env as Record<string, string | undefined>;
const savedSecret = env.TOURBILLON_AGENT_TOKEN_SECRET;

type Row = Record<string, unknown>;
type Cond = { op: 'eq'; c: string; val: unknown } | { op: 'and'; xs: Cond[] } | { op: 'other' };
const match = (r: Row, c?: Cond): boolean =>
  !c || c.op === 'other' ? true : c.op === 'eq' ? r[c.c] === c.val : c.xs.every((x) => match(r, x));
const table = (name: string) =>
  new Proxy({}, { get: (_t, prop: string) => (prop === '__table' ? name : { c: prop, t: name }) });

const store: Record<string, Row[]> = {};
const lookups: string[] = [];
let harnessCalls = 0;

const providerRow = (over: Row = {}): Row => ({
  id: 'prov-default', name: 'Registry Default', type: 'openai-compatible', baseURL: 'http://gw.test:8000/v1',
  apiKey: KEY, headers: {}, apiMode: 'chat', isDefault: true, defaultModelSettings: {}, defaultModel: null,
  stickiness: 'off', stickinessHeaderName: 'x-litellm-session-id', ...over,
});

describe('wake-runner provider resolution (agent → registry default → env)', () => {
  let triggerWake: typeof import('./wake-runner').triggerWake;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    const tables = {
      agents: table('agents'),
      companies: table('companies'),
      heartbeatRuns: table('heartbeatRuns'),
      issues: table('issues'),
      costEvents: table('costEvents'),
      activityLog: table('activityLog'),
    };
    const fakeDb = {
      query: new Proxy({}, {
        get: (_t, name: string) => ({
          findFirst: async ({ where }: { where?: Cond } = {}) => (store[name] ?? []).find((r) => match(r, where)),
        }),
      }),
      insert: (t: { __table: string }) => ({
        values: async (row: Row) => {
          (store[t.__table] ??= []).push({ ...row });
        },
      }),
      update: (t: { __table: string }) => ({
        set: (patch: Row) => ({
          where: async (where: Cond) => {
            for (const r of store[t.__table] ?? []) if (match(r, where)) Object.assign(r, patch);
          },
        }),
      }),
    };
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      if (!this?.filename?.endsWith('wake-runner.ts')) {
        return originalRequire.apply(this, arguments as unknown as [string]);
      }
      if (id === '@tourbillon/db') {
        return {
          db: fakeDb,
          ...tables,
          getLlmProviderRowById: async (pid: string) => {
            lookups.push(`byId:${pid}`);
            return (store.llmProviders ?? []).find((r) => r.id === pid) ?? null;
          },
          getDefaultLlmProviderRow: async () => {
            lookups.push('default');
            return (store.llmProviders ?? []).find((r) => r.isDefault) ?? null;
          },
        };
      }
      if (id === 'drizzle-orm') {
        return {
          eq: (col: { c: string }, val: unknown) => ({ op: 'eq', c: col.c, val }),
          and: (...xs: Cond[]) => ({ op: 'and', xs }),
          sql: () => ({ op: 'other' }),
          lt: () => ({ op: 'other' }),
        };
      }
      if (id === './redis-pub' || id.endsWith('/redis-pub')) {
        return { redisPub: { publish: async () => 1 } };
      }
      if (id === './adapters/harness-adapter' || id.endsWith('/adapters/harness-adapter')) {
        return {
          runWithHarness: async () => {
            harnessCalls += 1;
            throw new Error('harness must not run');
          },
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ triggerWake } = await import('./wake-runner'));
  });

  after(() => {
    if (savedSecret === undefined) delete env.TOURBILLON_AGENT_TOKEN_SECRET;
    else env.TOURBILLON_AGENT_TOKEN_SECRET = savedSecret;
  });

  const setAgent = (over: Row = {}) => {
    store.agents = [{
      id: 'agent-a', companyId: 'company-a', name: 'Alice', urlKey: 'alice', status: 'active',
      adapterType: 'harness', adapterConfig: {}, modelId: 'local/model', providerId: null,
      runtimeConfig: { timeout: { heartbeatSec: 300 } }, budgetMonthlyTokens: 1_000_000, spentMonthlyTokens: 0,
      ...over,
    }];
  };

  beforeEach(() => {
    // No token secret: a run that passes provider resolution stops at the token step, after its
    // row (with the provider snapshot) is written. Nothing reaches the harness/LLM.
    delete env.TOURBILLON_AGENT_TOKEN_SECRET;
    harnessCalls = 0;
    lookups.length = 0;
    setAgent();
    store.companies = [{ id: 'company-a', status: 'active' }];
    store.heartbeatRuns = [];
    store.llmProviders = [];
  });

  const wake = () =>
    triggerWake({ agentId: 'agent-a', companyId: 'company-a', invocationSource: 'on_demand', wakeReason: 'manual' } as never);
  const snapshot = () => store.heartbeatRuns[0]?.contextSnapshot as Row;

  it("agent with its own provider → that provider (the registry default isn't read)", async () => {
    store.llmProviders = [providerRow(), providerRow({ id: 'prov-own', name: 'Own', isDefault: false })];
    setAgent({ providerId: 'prov-own' });
    const result = await wake();
    assert.match(result.errorText ?? '', /TOURBILLON_AGENT_TOKEN_SECRET/);
    assert.equal(snapshot().providerId, 'prov-own');
    assert.equal(snapshot().providerSource, 'agent');
    assert.equal(snapshot().providerName, 'Own');
    assert.deepEqual(lookups, ['byId:prov-own']);
  });

  it('agent without a provider → the registry default (was: env)', async () => {
    store.llmProviders = [providerRow()];
    await wake();
    assert.equal(snapshot().providerId, 'prov-default');
    assert.equal(snapshot().providerSource, 'registry_default');
    assert.equal(snapshot().providerName, 'Registry Default');
    assert.deepEqual(lookups, ['default']);
  });

  it("agent's provider row is gone → the registry default", async () => {
    store.llmProviders = [providerRow()];
    setAgent({ providerId: 'prov-deleted' });
    await wake();
    assert.equal(snapshot().providerId, 'prov-default');
    assert.equal(snapshot().providerSource, 'registry_default');
    assert.deepEqual(lookups, ['byId:prov-deleted', 'default']);
  });

  it('no agent provider and no registry default → env', async () => {
    store.llmProviders = [providerRow({ isDefault: false })];
    await wake();
    assert.equal(snapshot().providerId, null);
    assert.equal(snapshot().providerSource, 'env');
    assert.equal(typeof snapshot().providerName, 'string');
  });

  it('adapterConfig.baseURL on another host + provider key → run failed with llm_provider_base_url_host_mismatch, no token, no harness', async () => {
    env.TOURBILLON_AGENT_TOKEN_SECRET = SECRET;
    store.llmProviders = [providerRow()];
    setAgent({ adapterConfig: { baseURL: 'http://elsewhere.test:8000/v1' } });
    const result = await wake();
    assert.equal(result.status, 'failed');
    assert.match(result.errorText ?? '', /^llm_provider_base_url_host_mismatch: /);
    assert.ok(!(result.errorText ?? '').includes(KEY));
    const run = store.heartbeatRuns[0];
    assert.equal(run.status, 'failed');
    assert.match(String(run.errorText), /llm_provider_base_url_host_mismatch/);
    assert.equal(snapshot().providerId, 'prov-default');
    assert.equal(harnessCalls, 0, 'the run must stop before the harness/LLM');
  });

  it("same-host adapterConfig.baseURL override isn't refused: the run passes provider resolution", async () => {
    // No token secret, so the run stops at the next step (the token) instead of the harness.
    store.llmProviders = [providerRow()];
    setAgent({ adapterConfig: { baseURL: 'http://gw.test:8000/v2' } });
    const result = await wake();
    assert.equal(result.status, 'failed');
    assert.doesNotMatch(String(result.errorText), /host_mismatch/);
    assert.match(String(result.errorText), /TOURBILLON_AGENT_TOKEN_SECRET is not set/);
    assert.equal(snapshot().providerId, 'prov-default');
    assert.equal(harnessCalls, 0);
  });
});
