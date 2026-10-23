/**
 * PRV-1: an agent cannot be saved onto an LLM provider that is switched off for its company
 * (model save, observational-memory save, clone, and the mobile PATCH that sets a provider).
 * New agents start on the company default. Real lib/agents.ts; @tourbillon/db and heavy
 * runtime deps are mocked.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

type Row = Record<string, unknown> & { id: string; companyId: string; urlKey: string };
type Cond = { col: string; val: unknown } | { and: Cond[] };

const PROVIDERS: Record<string, string> = { 'p-on': 'Cloud', 'p-off': 'Local studio' };
const OFF = new Set(['p-off']);

let rows: Row[];
let updates: Array<Record<string, unknown>>;
let inserts: Array<Record<string, unknown>>;
let assertCalls: Array<[string, unknown]>;

function flatten(c: Cond | undefined): Array<{ col: string; val: unknown }> {
  if (!c) return [];
  return 'and' in c ? c.and.flatMap(flatten) : [c];
}

function disabledError(providerId: string) {
  const err = new Error(`The LLM provider "${PROVIDERS[providerId]}" is switched off for this company.`);
  err.name = 'LlmProviderDisabledForCompanyError';
  return err;
}

function baseAgent(over: Partial<Row> = {}): Row {
  return {
    id: 'agent-1',
    companyId: 'co-a',
    name: 'Writer',
    title: 'Writer',
    role: 'engineer',
    urlKey: 'writer',
    providerId: 'p-on',
    modelId: 'm-1',
    adapterType: 'mastra',
    adapterConfig: {},
    assignedSkills: [],
    assignedToolsets: [],
    mcpServerIds: [],
    runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300 } },
    ...over,
  };
}

describe('PRV-1 agent saves refuse a provider switched off for the company', () => {
  let lib: typeof import('./agents');
  let patchAgent: (req: NextRequest, ctx: { params: Promise<{ urlKey: string }> }) => Promise<Response>;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    const dbMock = {
      agents: { id: 'id', companyId: 'companyId', urlKey: 'urlKey' },
      companies: { id: 'id' },
      activityLog: {},
      assertLlmProviderEnabledForCompany: async (companyId: string, providerId: unknown) => {
        assertCalls.push([companyId, providerId]);
        if (typeof providerId === 'string' && OFF.has(providerId)) throw disabledError(providerId);
      },
      db: {
        query: {
          agents: {
            findFirst: async ({ where }: { where?: Cond }) => {
              const conds = flatten(where);
              return rows.find((r) => conds.every((c) => r[c.col] === c.val)) ?? null;
            },
          },
        },
        update: () => ({
          set: (payload: Record<string, unknown>) => {
            updates.push(payload);
            return { where: () => ({ returning: async () => [{ ...rows[0], ...payload }] }) };
          },
        }),
        insert: () => ({
          values: (payload: Record<string, unknown>) => {
            inserts.push(payload);
            return { returning: async () => [{ id: 'agent-new', ...payload }] };
          },
        }),
      },
    };
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      const from = this.filename ?? '';
      const fromAgents = from.endsWith('/lib/agents.ts');
      if (id === '@tourbillon/db' && (fromAgents || from.includes('/api/mobile/agents/'))) return dbMock;
      if (id === 'drizzle-orm' && fromAgents) {
        return {
          eq: (col: string, val: unknown) => ({ col, val }),
          and: (...conds: Cond[]) => ({ and: conds }),
        };
      }
      if (id === '@tourbillon/mastra' && fromAgents) return { clearIdleThreadOnRuntimeSwitch: async () => {} };
      if ((id === './chat' || id === './llm-providers' || id === './company') && fromAgents) {
        return {
          invalidateChatControllerForAgent: () => {},
          getCompanyDefaultLlmProviderRecord: async () => null,
          getActiveCompany: async () => ({ id: 'co-a' }),
        };
      }
      if (id === '@/lib/mobile-session' || id.endsWith('/lib/mobile-session')) {
        return {
          requireMobileCompany: async () => ({ company: { id: 'co-a', allowedMcpServerIds: [] } }),
          toJson: (data: unknown) => JSON.parse(JSON.stringify(data)),
        };
      }
      if (id === '@/lib/llm-providers' && from.includes('/api/mobile/agents/')) {
        return { listLlmProvidersForCompanyPicker: async () => [] };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    lib = await import('./agents');
    ({ PATCH: patchAgent } = (await import('../app/api/mobile/agents/[urlKey]/route')) as unknown as {
      PATCH: typeof patchAgent;
    });
    Module.prototype.require = originalRequire;
  });

  beforeEach(() => {
    rows = [baseAgent()];
    updates = [];
    inserts = [];
    assertCalls = [];
  });

  const rejectsNaming = async (fn: () => Promise<unknown>) =>
    assert.rejects(fn, (err: Error) => {
      assert.ok(err instanceof lib.AgentValidationError, `expected AgentValidationError, got ${err.name}`);
      assert.match(err.message, /"Local studio" is switched off for this company/);
      return true;
    });

  it('updateAgentModel refuses a switched-off provider and writes nothing', async () => {
    await rejectsNaming(() => lib.updateAgentModel('agent-1', { modelId: 'm-2', providerId: 'p-off' }));
    assert.equal(updates.length, 0);
    assert.deepEqual(assertCalls, [['co-a', 'p-off']]);
  });

  it('updateAgentModel saves an enabled provider, or clears it', async () => {
    await lib.updateAgentModel('agent-1', { modelId: 'm-2', providerId: 'p-on' });
    await lib.updateAgentModel('agent-1', { modelId: 'm-3', providerId: null });
    assert.deepEqual(updates.map((u) => u.providerId), ['p-on', null]);
  });

  it('updateAgentModel without a provider change does not check providers', async () => {
    rows = [baseAgent({ providerId: 'p-off' })];
    await lib.updateAgentModel('agent-1', { modelId: 'm-2' });
    assert.equal(updates.length, 1);
    assert.deepEqual(assertCalls, []);
  });

  it('updateAgentObservationalMemory refuses a switched-off provider', async () => {
    await rejectsNaming(() =>
      lib.updateAgentObservationalMemory('agent-1', { mode: 'on', providerId: 'p-off', modelId: 'm-1' }),
    );
    assert.equal(updates.length, 0);
  });

  it('cloneAgent refuses when the source agent is on a switched-off provider', async () => {
    rows = [baseAgent({ providerId: 'p-off' })];
    await rejectsNaming(() =>
      lib.cloneAgent({ sourceAgentId: 'agent-1', name: 'Writer copy', urlKey: 'writer-copy' }),
    );
    assert.equal(inserts.length, 0);
  });

  it('mobile PATCH section=model with a switched-off provider returns 400 naming it', async () => {
    const req = new NextRequest('http://localhost/api/mobile/agents/writer', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ section: 'model', modelId: 'm-2', providerId: 'p-off' }),
    });
    const res = await patchAgent(req, { params: Promise.resolve({ urlKey: 'writer' }) });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /"Local studio" is switched off for this company/);
    assert.equal(updates.length, 0);
  });

  it('mobile PATCH section=model with an enabled provider still saves', async () => {
    const req = new NextRequest('http://localhost/api/mobile/agents/writer', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ section: 'model', modelId: 'm-2', providerId: 'p-on' }),
    });
    const res = await patchAgent(req, { params: Promise.resolve({ urlKey: 'writer' }) });
    assert.equal(res.status, 200);
    assert.equal(updates[0]?.providerId, 'p-on');
  });
});
