/**
 * PRV-1: PATCH /api/companies/{companyId}/llm-providers/{id}. The real board guard runs; its
 * session/company lookups, the provider store, the DB and the chat cache are stubbed.
 */
import { before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

type Company = { id: string; name: string };
let activeCompany: Company | null = null;
let calls: Array<{ companyId: string; providerId: string; enabled: boolean }> = [];
let knownProviders = new Set<string>();
let previous = new Map<string, boolean>();
let invalidated: string[] = [];

describe('PATCH /api/companies/[companyId]/llm-providers/[id]', () => {
  let PATCH: (
    req: NextRequest,
    ctx: { params: Promise<{ companyId: string; id: string }> },
  ) => Promise<Response>;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (id: string) {
      if (id === './company' || id.endsWith('/lib/company')) {
        return {
          getActiveCompanyOrNull: async () => activeCompany,
          hasBoardSession: async () => activeCompany !== null,
        };
      }
      if (id === './mobile-auth' || id.endsWith('/lib/mobile-auth')) {
        return { verifyMobileToken: async () => null };
      }
      if (id === '@/lib/llm-providers' || id.endsWith('/lib/llm-providers')) {
        return {
          setLlmProviderEnabledForCompany: async (companyId: string, providerId: string, enabled: boolean) => {
            calls.push({ companyId, providerId, enabled });
            if (!knownProviders.has(providerId)) return null;
            const key = `${companyId}:${providerId}`;
            const was = previous.get(key) ?? true;
            previous.set(key, enabled);
            return { providerId, companyId, enabledForCompany: enabled, changed: was !== enabled };
          },
        };
      }
      if (id === '@/lib/chat' || id.endsWith('/lib/chat')) {
        return { invalidateChatControllerForAgent: (agentId: string) => void invalidated.push(agentId) };
      }
      if (id === '@tourbillon/db') {
        return {
          agents: { id: 'id', companyId: 'companyId' },
          db: {
            select: () => ({
              from: () => ({ where: async () => [{ id: 'agent-1' }, { id: 'agent-2' }] }),
            }),
          },
        };
      }
      if (id === 'drizzle-orm') return { eq: () => ({}) };
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ PATCH } = (await import('./route')) as unknown as { PATCH: typeof PATCH });
    Module.prototype.require = originalRequire;
  });

  beforeEach(() => {
    activeCompany = { id: 'co-a', name: 'Alpha' };
    calls = [];
    knownProviders = new Set(['p-local']);
    previous = new Map();
    invalidated = [];
  });

  const call = async (
    body: unknown,
    { companyId = 'co-a', id = 'p-local', headers = {} as Record<string, string> } = {},
  ) => {
    const req = new NextRequest(`http://localhost/api/companies/${companyId}/llm-providers/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const res = await PATCH(req, { params: Promise.resolve({ companyId, id }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('company admin (board, active company) switches a provider off', async () => {
    const res = await call({ enabled: false });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { providerId: 'p-local', companyId: 'co-a', enabledForCompany: false });
    assert.deepEqual(calls, [{ companyId: 'co-a', providerId: 'p-local', enabled: false }]);
    // Cached chat controllers for the company are dropped so chat re-resolves the provider.
    assert.deepEqual(invalidated, ['agent-1', 'agent-2']);
  });

  it('no change → chat cache left alone', async () => {
    const res = await call({ enabled: true });
    assert.equal(res.status, 200);
    assert.deepEqual(invalidated, []);
  });

  it('agent run token → 403, nothing written', async () => {
    const res = await call({ enabled: false }, { headers: { authorization: 'Bearer pm_run_abc123' } });
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  });

  it('agent chat token → 403, nothing written', async () => {
    const res = await call({ enabled: false }, { headers: { authorization: 'Bearer pm_chat_abc123' } });
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  });

  it('no board session → 401, nothing written', async () => {
    activeCompany = null;
    const res = await call({ enabled: false });
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });

  it('another company in the path → 403, nothing written', async () => {
    const res = await call({ enabled: false }, { companyId: 'co-b' });
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  });

  it('missing or non-boolean "enabled" → 400', async () => {
    assert.equal((await call({})).status, 400);
    assert.equal((await call({ enabled: 'false' })).status, 400);
    assert.equal((await call('not json')).status, 400);
    assert.equal(calls.length, 0);
  });

  it('unknown provider → 404', async () => {
    const res = await call({ enabled: false }, { id: 'nope' });
    assert.equal(res.status, 404);
  });
});
