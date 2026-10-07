import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';

/**
 * #103: PUT/DELETE/GET /api/agents/:agentId/secrets — board auth + write-only responses.
 * DB-backed modules (@/lib/agents, @/lib/company) are mocked via Module.prototype.require,
 * the same approach as app/api/mobile/agents-route.test.ts. Token checks use the real
 * @/lib/mobile-auth (jose); agent bearers are refused by pm_run_/pm_chat_ prefix. All credential values are fakes.
 */

const SESSION_SECRET = new TextEncoder().encode(
  process.env.BETTER_AUTH_SECRET || 'change-me-in-production'
);

async function boardTokenFor(companyId: string): Promise<string> {
  return new SignJWT({ companyId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(SESSION_SECRET);
}

function runTokenFor(agentId: string, companyId: string): string {
  const payload = { runId: 'run-1', agentId, companyId, iat: Date.now() };
  return `pm_run_${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

const FAKE = {
  secret: 'fixture-secret-value-0001',
  mcp: 'fixture-mcp-credential-0002',
  tavily: 'tvly-fixture-key-0003',
  searxng: 'fixture-searxng-key-0004',
  newSecret: 'fixture-new-secret-0005',
};

type MockAgent = { id: string; urlKey: string; companyId: string; runtimeConfig: Record<string, any> };

function freshAgents(): MockAgent[] {
  return [
    {
      id: 'agent-a1',
      urlKey: 'testsuper',
      companyId: 'company-a',
      runtimeConfig: {
        heartbeat: { enabled: true },
        secrets: { TEST_PASSWORD: FAKE.secret },
        mcpCredentials: { 'buffer-mcp': FAKE.mcp },
        tavilyApiKey: FAKE.tavily,
        searxngApiKey: FAKE.searxng,
      },
    },
    { id: 'agent-a2', urlKey: 'cyber', companyId: 'company-a', runtimeConfig: {} },
    { id: 'agent-b1', urlKey: 'other', companyId: 'company-b', runtimeConfig: {} },
  ];
}

const companies = new Map([
  ['company-a', { id: 'company-a', name: 'Company A' }],
  ['company-b', { id: 'company-b', name: 'Company B' }],
]);

let agents: MockAgent[] = freshAgents();
/** Simulated active-company board cookie for the current request. */
let activeCompanyCookie: string | null = null;
let writes = 0;

describe('/api/agents/:agentId/secrets (#103)', () => {
  let PUT: any;
  let DELETE: any;
  let GET: any;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    class AgentValidationError extends Error {}

    Module.prototype.require = function (this: any, id: string) {
      if (id === '@/lib/agents' || id.endsWith('/lib/agents')) {
        return {
          AgentValidationError,
          // Mirrors lib/agents.ts: scoped to companyId if given, else to the active-company cookie.
          getAgentByUrlKey: async (urlKey: string, companyId?: string) => {
            const scope = companyId ?? activeCompanyCookie;
            if (!scope) return null;
            return agents.find((a) => a.urlKey === urlKey && a.companyId === scope) ?? null;
          },
          updateAgentSecrets: async (agentId: string, input: { secrets: Record<string, string>; replace?: boolean }) => {
            writes++;
            const agent = agents.find((a) => a.id === agentId)!;
            const existing = input.replace ? {} : (agent.runtimeConfig.secrets ?? {});
            agent.runtimeConfig = { ...agent.runtimeConfig, secrets: { ...existing, ...input.secrets } };
            return agent;
          },
          deleteAgentSecrets: async (agentId: string, keys: string[]) => {
            writes++;
            const agent = agents.find((a) => a.id === agentId)!;
            const secrets = { ...(agent.runtimeConfig.secrets ?? {}) };
            for (const k of keys) delete secrets[k];
            agent.runtimeConfig = { ...agent.runtimeConfig, secrets };
            return agent;
          },
        };
      }
      if (id === '@/lib/company' || id.endsWith('/lib/company')) {
        return {
          // Mirrors lib/company.ts: explicit override (mobile token company) wins, else cookie.
          getActiveCompanyOrNull: async (override?: string | null) =>
            companies.get(override ?? activeCompanyCookie ?? '') ?? null,
          getActiveCompany: async () => {
            const c = companies.get(activeCompanyCookie ?? '');
            if (!c) throw new Error('No active company');
            return c;
          },
        };
      }
      return originalRequire.apply(this, [id]);
    };

    const route = await import('./route');
    PUT = route.PUT;
    DELETE = route.DELETE;
    GET = route.GET;
  });

  beforeEach(() => {
    agents = freshAgents();
    activeCompanyCookie = null;
    writes = 0;
  });

  function req(method: string, headers: Record<string, string> = {}, body?: unknown) {
    return new NextRequest('http://localhost/api/agents/testsuper/secrets', {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  const ctx = (urlKey = 'testsuper') => ({ params: Promise.resolve({ agentId: urlKey }) });
  const putBody = { secrets: { NEW_KEY: FAKE.newSecret } };

  it('rejects an unauthenticated PUT with 401 and writes nothing', async () => {
    const res = await PUT(req('PUT', {}, putBody), ctx());
    assert.equal(res.status, 401);
    assert.equal(writes, 0);
  });

  it('rejects an unauthenticated DELETE and GET with 401', async () => {
    assert.equal((await DELETE(req('DELETE', {}, { keys: ['TEST_PASSWORD'] }), ctx())).status, 401);
    assert.equal((await GET(req('GET'), ctx())).status, 401);
    assert.equal(writes, 0);
  });

  it("blocks another company's board (token for company-b, agent in company-a) with 404", async () => {
    const token = await boardTokenFor('company-b');
    const res = await PUT(req('PUT', { 'x-company-token': token }, putBody), ctx());
    assert.ok([403, 404].includes(res.status), `got ${res.status}`);
    assert.equal(writes, 0);
    const del = await DELETE(req('DELETE', { 'x-company-token': token }, { keys: ['TEST_PASSWORD'] }), ctx());
    assert.ok([403, 404].includes(del.status));
    assert.equal(writes, 0);
  });

  it("rejects a peer agent's run token even with the company cookie set (403)", async () => {
    // A peer agent knows its companyId (it is in its own token) and can send the cookie.
    activeCompanyCookie = 'company-a';
    const res = await PUT(
      req('PUT', { authorization: `Bearer ${runTokenFor('agent-a2', 'company-a')}` }, putBody),
      ctx(),
    );
    assert.equal(res.status, 403);
    assert.equal(writes, 0);
    const del = await DELETE(
      req('DELETE', { authorization: `Bearer ${runTokenFor('agent-a2', 'company-a')}` }, { keys: ['TEST_PASSWORD'] }),
      ctx(),
    );
    assert.equal(del.status, 403);
    assert.equal(writes, 0);
  });

  it('rejects any pm_run_/pm_chat_ bearer (chat, malformed, unsigned, signed-format) with 403 even with the company cookie set', async () => {
    activeCompanyCookie = 'company-a';
    const chatPayload = Buffer.from(
      JSON.stringify({ chatSessionId: 'chat-agent-a2', agentId: 'agent-a2', companyId: 'company-a', iat: Date.now() }),
    ).toString('base64url');
    const bearers = [
      `pm_chat_${chatPayload}`,
      'pm_run_not-base64-json',
      'pm_chat_',
      `${runTokenFor('agent-a2', 'company-a')}.Zm9yZ2VkLXNpZ25hdHVyZQ`,
    ];
    for (const bearer of bearers) {
      const res = await PUT(req('PUT', { authorization: `Bearer ${bearer}` }, putBody), ctx());
      assert.equal(res.status, 403, `PUT with ${bearer.slice(0, 12)}…`);
      const del = await DELETE(
        req('DELETE', { authorization: `Bearer ${bearer}` }, { keys: ['TEST_PASSWORD'] }),
        ctx(),
      );
      assert.equal(del.status, 403, `DELETE with ${bearer.slice(0, 12)}…`);
    }
    assert.equal(writes, 0);
  });

  it('PUT by the board succeeds and the response contains key names only, no values', async () => {
    const res = await PUT(req('PUT', { 'x-company-token': await boardTokenFor('company-a') }, putBody), ctx());
    assert.equal(res.status, 200);
    const text = await res.text();
    for (const v of Object.values(FAKE)) assert.ok(!text.includes(v), `response leaked ${v}`);
    const json = JSON.parse(text);
    assert.deepEqual(json.keys.sort(), ['NEW_KEY', 'TEST_PASSWORD']);
    assert.equal(writes, 1);
  });

  it('DELETE by the board (cookie session) succeeds and the response contains no values', async () => {
    activeCompanyCookie = 'company-a';
    const res = await DELETE(req('DELETE', {}, { keys: ['TEST_PASSWORD'] }), ctx());
    assert.equal(res.status, 200);
    const text = await res.text();
    for (const v of Object.values(FAKE)) assert.ok(!text.includes(v), `response leaked ${v}`);
    assert.deepEqual(JSON.parse(text).keys, []);
  });

  it('GET by the board returns key names only', async () => {
    const res = await GET(req('GET', { 'x-company-token': await boardTokenFor('company-a') }), ctx());
    assert.equal(res.status, 200);
    const text = await res.text();
    for (const v of Object.values(FAKE)) assert.ok(!text.includes(v));
    assert.deepEqual(JSON.parse(text), { keys: ['TEST_PASSWORD'], count: 1 });
  });
});
