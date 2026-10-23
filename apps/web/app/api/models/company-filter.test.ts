/**
 * PRV-1: /api/models only serves providers that are on for the board's company. The provider
 * settings page passes includeDisabled=1 so it can still list every provider's models.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';

type Rec = { id: string; name: string; isDefault: boolean };
const RECORDS: Rec[] = [
  { id: 'p-default', name: 'Default gateway', isDefault: true },
  { id: 'p-local', name: 'Local studio', isDefault: false },
];

let disabled: Set<string>;
let company: { id: string } | null;
let agent: { id: string; providerId: string | null } | null;
let listedFor: string[];
let agentListedFor: Array<string | null>;
let defaultResponseCalls: number;

function effective(requested: string | null): string | null {
  const asked = requested ?? RECORDS.find((r) => r.isDefault)?.id ?? null;
  if (!asked) return null;
  if (!disabled.has(asked)) return asked;
  const on = RECORDS.filter((r) => !disabled.has(r.id));
  const fb = on.find((r) => r.isDefault) ?? on[0];
  if (!fb) {
    const err = new Error('No LLM provider is enabled for this company.');
    err.name = 'NoEnabledLlmProviderError';
    throw err;
  }
  return fb.id;
}

describe('PRV-1 /api/models company filter', () => {
  let GET: (req: NextRequest) => Promise<Response>;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      const fromRoute = this.filename?.endsWith('/api/models/route.ts');
      if (!fromRoute) return originalRequire.apply(this, arguments as unknown as [string]);
      if (id === '@tourbillon/db') {
        return {
          agents: { id: 'id', companyId: 'companyId' },
          db: { query: { agents: { findFirst: async () => agent } } },
          llmProviderDisabledForCompanyMessage: (name: string) =>
            `The LLM provider "${name}" is switched off for this company.`,
        };
      }
      if (id === 'drizzle-orm') return { eq: () => ({}), and: () => ({}) };
      if (id === '@/lib/llm-providers') {
        return {
          getLlmProviderRecordById: async (pid: string) => RECORDS.find((r) => r.id === pid) ?? null,
          getDefaultLlmProviderRecord: async () => RECORDS.find((r) => r.isDefault) ?? null,
          isLlmProviderOnForCompany: async (_c: string, pid: string) => !disabled.has(pid),
          effectiveLlmProviderIdForCompany: async (_c: string, pid: string | null) => effective(pid),
        };
      }
      if (id === '@/lib/model-catalog') {
        return {
          listProviderModelsForRecord: async (rec: Rec) => {
            listedFor.push(rec.id);
            return { provider: rec.id, models: [`${rec.id}-model`] };
          },
          listProviderModelsForAgent: async (_a: unknown, _c: unknown, _m: unknown, rec: Rec | null) => {
            agentListedFor.push(rec?.id ?? null);
            return { provider: rec?.id ?? null, models: [] };
          },
        };
      }
      if (id === '@/lib/default-provider-models') {
        return {
          defaultProviderModelsResponse: async () => {
            defaultResponseCalls++;
            return Response.json({ provider: 'registry-default' });
          },
        };
      }
      if (id === '@/lib/board-route-auth') {
        return {
          requireBoardIdentity: async () => ({ ok: true, value: true }),
          requireBoardCompany: async () => ({ ok: true, value: { id: 'co-a' } }),
          activeBoardCompanyOrNull: async () => company,
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ GET } = (await import('./route')) as unknown as { GET: typeof GET });
    Module.prototype.require = originalRequire;
  });

  beforeEach(() => {
    disabled = new Set();
    company = { id: 'co-a' };
    agent = { id: 'agent-1', providerId: 'p-local' };
    listedFor = [];
    agentListedFor = [];
    defaultResponseCalls = 0;
  });

  const call = async (qs: string) => {
    const res = await GET(new NextRequest(`http://localhost/api/models${qs}`));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('?providerId of a provider that is on → models', async () => {
    const res = await call('?providerId=p-local');
    assert.equal(res.status, 200);
    assert.deepEqual(listedFor, ['p-local']);
  });

  it('?providerId of a provider switched off for the company → 409 naming it, no upstream call', async () => {
    disabled = new Set(['p-local']);
    const res = await call('?providerId=p-local');
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'provider_disabled_for_company');
    assert.match(String(res.body.error), /"Local studio" is switched off/);
    assert.deepEqual(listedFor, []);
  });

  it('settings page (includeDisabled=1) still lists a switched-off provider', async () => {
    disabled = new Set(['p-local']);
    const res = await call('?providerId=p-local&includeDisabled=1');
    assert.equal(res.status, 200);
    assert.deepEqual(listedFor, ['p-local']);
  });

  it('no active company keeps the existing behaviour', async () => {
    disabled = new Set(['p-local']);
    company = null;
    assert.equal((await call('?providerId=p-local')).status, 200);
  });

  it('?agentId on a switched-off provider lists the company default instead', async () => {
    disabled = new Set(['p-local']);
    const res = await call('?agentId=agent-1');
    assert.equal(res.status, 200);
    assert.deepEqual(agentListedFor, ['p-default']);
  });

  it('?agentId on a provider that is on lists it', async () => {
    await call('?agentId=agent-1');
    assert.deepEqual(agentListedFor, ['p-local']);
  });

  it('no params: registry default on → unchanged default response', async () => {
    const res = await call('');
    assert.equal(res.status, 200);
    assert.equal(defaultResponseCalls, 1);
    assert.deepEqual(listedFor, []);
  });

  it('no params: registry default off → company default models', async () => {
    disabled = new Set(['p-default']);
    const res = await call('');
    assert.equal(res.status, 200);
    assert.equal(defaultResponseCalls, 0);
    assert.deepEqual(listedFor, ['p-local']);
  });

  it('nothing on for the company → 409 no_provider_enabled_for_company', async () => {
    disabled = new Set(['p-default', 'p-local']);
    const res = await call('');
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'no_provider_enabled_for_company');
  });

  it('only the provider settings page opts in to includeDisabled', () => {
    const root = path.join(__dirname, '..', '..', '..');
    const settings = readFileSync(path.join(root, 'components', 'llm-providers-settings.tsx'), 'utf8');
    const calls = settings.match(/\/api\/models\?providerId=[^`]*/g) ?? [];
    assert.ok(calls.length >= 2);
    for (const c of calls) assert.match(c, /includeDisabled=1/);
    for (const picker of [
      path.join('app', '(dashboard)', 'agent', '[urlKey]', 'agent-model-form.tsx'),
      path.join('app', '(dashboard)', 'agent', '[urlKey]', 'agent-om-settings-form.tsx'),
      path.join('components', 'observational-memory-settings-form.tsx'),
    ]) {
      assert.doesNotMatch(readFileSync(path.join(root, picker), 'utf8'), /includeDisabled/);
    }
  });
});
