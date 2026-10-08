/**
 * #106: negative (and positive) auth tests for routes that had no auth check.
 * Real auth stack (board-auth, mobile-auth, company.getActiveCompanyOrNull); db, next/headers
 * and heavy side-effect modules are mocked with a tiny in-memory store.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { mintChatToken, mintRunToken } from '@tourbillon/shared/agent-token';
import { validateRunToken } from '../../lib/auth/run-token';

const BOARD_SECRET = 'test-operator-secret-106';
// #108 refuses the public default BETTER_AUTH_SECRET whatever NODE_ENV is, so board JWTs are
// signed with a dedicated non-default test secret (>= 32 chars).
const JWT_SECRET = 'test-better-auth-secret-106-board-jwt-0123456789';
// #110/#111 signed agent tokens (>= 32 chars).
const AGENT_TOKEN_SECRET = 'test-agent-token-secret-106-0123456789abcdef';
const env = process.env as Record<string, string | undefined>;

// ---- in-memory db ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
type Cond = { op: 'eq'; c: string; val: unknown } | { op: 'and'; xs: Cond[] } | { op: 'in'; c: string; vals: unknown[] };
const store: Record<string, Row[]> = {};
function table(name: string) {
  return new Proxy({ __table: name } as Record<string, unknown>, {
    get: (t, prop: string) => (prop === '__table' ? name : { c: prop }),
  });
}
function match(row: Row, cond?: Cond): boolean {
  if (!cond) return true;
  if (cond.op === 'eq') return row[cond.c] === cond.val;
  if (cond.op === 'in') return cond.vals.includes(row[cond.c]);
  return cond.xs.every((x) => match(row, x));
}
const tables = Object.fromEntries(
  ['approvals', 'agents', 'companies', 'issues', 'activityLog', 'heartbeatRuns'].map((n) => [n, table(n)]),
);
const nameOf = (t: unknown) => (t as { __table: string }).__table;
const fakeDb = {
  query: new Proxy({}, {
    get: (_t, name: string) => ({
      findFirst: async ({ where }: { where?: Cond } = {}) => (store[name] ?? []).find((r) => match(r, where)),
    }),
  }),
  transaction: async <T>(fn: (tx: unknown) => Promise<T>) =>
    fn({
      update: (t: unknown) => ({
        set: (v: Row) => ({
          where: (cond: Cond) => ({
            returning: async () => {
              const rows = (store[nameOf(t)] ?? []).filter((r) => match(r, cond));
              rows.forEach((r) => Object.assign(r, v));
              return rows;
            },
          }),
        }),
      }),
      select: () => ({ from: (t: unknown) => ({ where: async (cond: Cond) => (store[nameOf(t)] ?? []).filter((r) => match(r, cond)) }) }),
      insert: (t: unknown) => ({ values: async (v: Row) => { (store[nameOf(t)] ??= []).push(v); } }),
    }),
};

// ---- request state (next/headers) --------------------------------------------------------------
const reqState: { cookies: Record<string, string>; headers: Record<string, string> } = { cookies: {}, headers: {} };

function sessionToken() {
  const key = new Uint8Array(createHmac('sha256', 'tourbillon-board-session-v1').update(BOARD_SECRET).digest());
  return new SignJWT({ typ: 'tourbillon_board_session' }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h').sign(key);
}
function boardJwt(companyId: string) {
  return new SignJWT({ companyId }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));
}
const agentToken = (companyId: string) =>
  `pm_run_${Buffer.from(JSON.stringify({ runId: 'run-a', agentId: 'agent-a', companyId, iat: 1 })).toString('base64url')}`;
/** Bearer used by the 'agent' caller; defaults to the legacy unsigned pm_run_ token. */
let agentBearer: string | null = null;

/** Agent-token variants built with #111's real minting helpers. */
function withEnv<T>(name: string, value: string, fn: () => T): T {
  const prev = env[name];
  env[name] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete env[name];
    else env[name] = prev;
  }
}
function minted(kind: 'run' | 'chat', variant: 'signed' | 'forged' | 'expired'): string {
  const ids = { agentId: 'agent-a', companyId: 'company-a' };
  const mint = () =>
    kind === 'run' ? mintRunToken({ runId: 'run-a', ...ids }, 3600) : mintChatToken({ chatSessionId: 'chat-agent-a', ...ids }, 3600);
  if (variant === 'signed') return withEnv('TOURBILLON_AGENT_TOKEN_SECRET', AGENT_TOKEN_SECRET, mint);
  if (variant === 'forged') {
    return withEnv('TOURBILLON_AGENT_TOKEN_SECRET', 'attacker-guessed-secret-0123456789abcdef', mint);
  }
  // expired: correctly signed, minted two hours ago with a one-hour TTL
  const realNow = Date.now;
  Date.now = () => realNow() - 2 * 3600 * 1000;
  try {
    return withEnv('TOURBILLON_AGENT_TOKEN_SECRET', AGENT_TOKEN_SECRET, mint);
  } finally {
    Date.now = realNow;
  }
}

type Who = 'anon' | 'agent' | 'boardA' | 'jwtA';
async function request(who: Who, url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  const cookies: Record<string, string> = {};
  if (who === 'boardA' || who === 'agent') {
    // the agent case also carries a valid board session + company cookie: still never board
    cookies.tourbillon_board_session = await sessionToken();
    cookies.active_company_id = 'company-a';
  }
  if (who === 'agent') {
    headers.authorization = `Bearer ${agentBearer ?? agentToken('company-a')}`;
    headers['x-company-token'] = await boardJwt('company-a');
  }
  if (who === 'jwtA') headers['x-company-token'] = await boardJwt('company-a');
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (Object.keys(cookies).length) headers.cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  reqState.cookies = cookies;
  reqState.headers = headers;
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
const ctx = <T>(params: T) => ({ params: Promise.resolve(params) });

type Handler = (req: NextRequest, c: { params: Promise<any> }) => Promise<Response>;
const routes: Record<string, Record<string, Handler>> = {};

describe('#106 board-guarded routes', () => {
  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    const is = (id: string, name: string) => id === `@/lib/${name}` || id.endsWith(`/lib/${name}`);
    const mocks: Record<string, unknown> = {
      'next/headers': {
        cookies: async () => ({
          get: (n: string) => (n in reqState.cookies ? { name: n, value: reqState.cookies[n] } : undefined),
          set: () => {},
          delete: () => {},
        }),
        headers: async () => new Headers(reqState.headers),
      },
      '@tourbillon/db': { db: fakeDb, ...tables },
      'drizzle-orm': {
        eq: (col: { c: string }, val: unknown) => ({ op: 'eq', c: col.c, val }),
        and: (...xs: Cond[]) => ({ op: 'and', xs }),
        inArray: (col: { c: string }, vals: unknown[]) => ({ op: 'in', c: col.c, vals }),
        ne: () => ({ op: 'and', xs: [] }),
        asc: (c: unknown) => c,
        desc: (c: unknown) => c,
      },
      '@tourbillon/mastra/mcp-tools': { listMcpToolsForAgent: async () => [{ id: 'srv', tools: [] }] },
      '@tourbillon/shared/knowledge-graph': {
        loadAgentKnowledgeGraph: async () => ({ path: 'p', exists: true, mtimeMs: 1, entities: [{ name: 'secret-memory' }], relations: [] }),
        loadCompanyKnowledgeGraph: async () => ({ path: 'c', exists: true, mtimeMs: 1, entities: [], relations: [] }),
        mergeKnowledgeGraphs: () => ({ entities: [], relations: [] }),
        searchKnowledgeGraph: (g: unknown) => g,
      },
    };
    let realShared: Record<string, unknown> | undefined;
    Module.prototype.require = function (id: string) {
      if (id in mocks) return mocks[id];
      if (id === '@tourbillon/shared') {
        realShared ??= originalRequire.apply(this, arguments as unknown as [string]);
        return { ...realShared, ensureCompanyWorkspace: async () => {} };
      }
      if (is(id, 'sse')) return { getSseSubscribers: () => new Set() };
      if (is(id, 'wake-client')) return { enqueueApprovalWake: async () => {} };
      if (is(id, 'issue-comments')) return { addIssueComment: async () => {} };
      if (is(id, 'queue')) return { isJobQueueName: (q: string) => q === 'heartbeat' };
      if (is(id, 'jobs')) return { getJobLiveSnapshot: async (_q: string, id2: string) => ({ state: 'active', heartbeatRun: { id: id2 } }) };
      if (is(id, 'heartbeats')) {
        return {
          getHeartbeatRun: async (runId: string) => {
            const run = (store.heartbeatRuns ?? []).find((r) => r.id === runId);
            return run ? { run, agent: null } : null;
          },
        };
      }
      if (is(id, 'model-catalog')) {
        const result = async () => ({ models: [{ id: 'm1' }], provider: 'openai', baseURL: 'http://x' });
        return { listProviderModels: result, listProviderModelsForAgent: result, listProviderModelsForRecord: result };
      }
      if (is(id, 'llm-providers')) {
        const pub = { id: 'prov-1', name: 'P', headers: { Authorization: '' }, headerNames: ['Authorization'], hasApiKey: true };
        return {
          LlmProviderValidationError: class extends Error {},
          listLlmProvidersPublic: async () => [pub],
          getLlmProviderPublic: async () => pub,
          createLlmProvider: async () => pub,
          updateLlmProvider: async () => pub,
          deleteLlmProvider: async () => {},
          getLlmProviderRecordById: async (id2: string) => (id2 === 'prov-1' ? { id: 'prov-1' } : null),
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };

    routes.decide = await import('./approvals/[approvalId]/decide/route');
    routes.mcpTools = await import('./agents/[agentId]/mcp-tools/route');
    routes.kg = await import('./agents/[agentId]/knowledge-graph/route');
    routes.sse = await import('./sse/[companyId]/route');
    routes.live = await import('./jobs/[queue]/[jobId]/live/route');
    routes.vault = await import('./vault/oauth/authorize/route');
    routes.providers = await import('./llm-providers/route');
    routes.provider = await import('./llm-providers/[id]/route');
    routes.models = await import('./models/route');
  });

  beforeEach(() => {
    env.TOURBILLON_BOARD_SECRET = BOARD_SECRET;
    env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
    env.BETTER_AUTH_SECRET = JWT_SECRET;
    env.TOURBILLON_AGENT_TOKEN_SECRET = AGENT_TOKEN_SECRET;
    agentBearer = null;
    store.companies = [{ id: 'company-a', name: 'A', settings: {}, allowedMcpServerIds: [] }, { id: 'company-b', name: 'B', settings: {}, allowedMcpServerIds: [] }];
    store.agents = [
      { id: 'agent-a', companyId: 'company-a', urlKey: 'alice', adapterType: 'lmstudio', adapterConfig: {}, modelId: 'm', providerId: null },
      { id: 'agent-b', companyId: 'company-b', urlKey: 'bob', adapterType: 'lmstudio', adapterConfig: {}, modelId: 'm', providerId: null },
    ];
    store.approvals = [
      { id: 'appr-a', companyId: 'company-a', status: 'pending', type: 'hire', payload: {}, issueIds: [], requestedByAgentId: null },
      { id: 'appr-b', companyId: 'company-b', status: 'pending', type: 'hire', payload: {}, issueIds: [], requestedByAgentId: null },
    ];
    store.heartbeatRuns = [{ id: 'run-a', companyId: 'company-a' }, { id: 'run-b', companyId: 'company-b' }];
    store.issues = [];
    store.activityLog = [];
  });

  // ---------------------------------------------------------------- approvals/[id]/decide
  describe('POST /api/approvals/:id/decide', () => {
    const decide = async (who: Who, approvalId: string) =>
      routes.decide.POST(await request(who, `/api/approvals/${approvalId}/decide`, { method: 'POST', body: { decision: 'approved' } }), ctx({ approvalId }));
    const status = (id: string) => store.approvals.find((a) => a.id === id)?.status;

    it('anonymous → 401, approval untouched', async () => {
      assert.equal((await decide('anon', 'appr-a')).status, 401);
      assert.equal(status('appr-a'), 'pending');
    });
    it('agent bearer (even with board cookie + JWT) cannot decide → 403, untouched', async () => {
      assert.equal((await decide('agent', 'appr-a')).status, 403);
      assert.equal(status('appr-a'), 'pending');
    });
    it("another company's approval → 404, untouched", async () => {
      assert.equal((await decide('boardA', 'appr-b')).status, 404);
      assert.equal(status('appr-b'), 'pending');
    });
    it('board session decides own company approval → 200', async () => {
      assert.equal((await decide('boardA', 'appr-a')).status, 200);
      assert.equal(status('appr-a'), 'approved');
    });
    it('board JWT decides own company approval → 200', async () => {
      assert.equal((await decide('jwtA', 'appr-a')).status, 200);
    });
  });

  // ---------------------------------------------------------------- sse
  describe('GET /api/sse/:companyId', () => {
    const sse = async (who: Who, companyId: string) =>
      routes.sse.GET(await request(who, `/api/sse/${companyId}`), ctx({ companyId }));
    it('anonymous → 401', async () => assert.equal((await sse('anon', 'company-a')).status, 401));
    it('agent bearer → 403', async () => assert.equal((await sse('agent', 'company-a')).status, 403));
    it("another company's stream → 403", async () => assert.equal((await sse('boardA', 'company-b')).status, 403));
    it('board reads own company stream → 200 event-stream', async () => {
      const res = await sse('boardA', 'company-a');
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/event-stream');
      await res.body?.cancel();
    });
  });

  // ---------------------------------------------------------------- agent-scoped GETs
  for (const [label, key, suffix] of [
    ['mcp-tools', 'mcpTools', 'mcp-tools'],
    ['knowledge-graph', 'kg', 'knowledge-graph'],
  ] as const) {
    describe(`GET /api/agents/:id/${label}`, () => {
      const call = async (who: Who, agentId: string) =>
        routes[key].GET(await request(who, `/api/agents/${agentId}/${suffix}`), ctx({ agentId }));
      it('anonymous → 401', async () => assert.equal((await call('anon', 'agent-a')).status, 401));
      it('agent bearer → 403', async () => assert.equal((await call('agent', 'agent-a')).status, 403));
      it("another company's agent → 404", async () => assert.equal((await call('boardA', 'agent-b')).status, 404));
      it('board, own company agent → 200', async () => assert.equal((await call('boardA', 'agent-a')).status, 200));
    });
  }

  // ---------------------------------------------------------------- jobs live
  describe('GET /api/jobs/:queue/:jobId/live', () => {
    const live = async (who: Who, jobId: string) =>
      routes.live.GET(await request(who, `/api/jobs/heartbeat/${jobId}/live`), ctx({ queue: 'heartbeat', jobId }));
    it('anonymous → 401', async () => assert.equal((await live('anon', 'run-a')).status, 401));
    it('agent bearer → 403', async () => assert.equal((await live('agent', 'run-a')).status, 403));
    it("another company's run → 404", async () => assert.equal((await live('boardA', 'run-b')).status, 404));
    it('board, own company run → 200', async () => assert.equal((await live('boardA', 'run-a')).status, 200));
  });

  // ---------------------------------------------------------------- vault oauth authorize
  describe('GET /api/vault/oauth/authorize', () => {
    const auth = async (who: Who, agentId?: string) =>
      routes.vault.GET(
        await request(who, `/api/vault/oauth/authorize?serverId=github-mcp&scope=${agentId ? 'agent' : 'company'}${agentId ? `&agentId=${agentId}` : ''}`),
        ctx({}),
      );
    it('anonymous → 401', async () => assert.equal((await auth('anon')).status, 401));
    it('agent bearer → 403', async () => assert.equal((await auth('agent')).status, 403));
    it("another company's agent → 404", async () => assert.equal((await auth('boardA', 'agent-b')).status, 404));
    it('board → redirect to GitHub', async () => {
      const res = await auth('boardA', 'agent-a');
      assert.equal(res.status, 307);
      assert.match(res.headers.get('location') ?? '', /^https:\/\/github\.com\/login\/oauth\/authorize/);
    });
  });

  // ---------------------------------------------------------------- llm-providers (instance-global)
  describe('/api/llm-providers(/:id)', () => {
    const cases: Array<[string, (who: Who) => Promise<Response>]> = [
      ['GET list', async (who) => routes.providers.GET(await request(who, '/api/llm-providers'), ctx({}))],
      ['POST create', async (who) => routes.providers.POST(await request(who, '/api/llm-providers', { method: 'POST', body: { name: 'x', type: 'openai', baseURL: 'http://evil' } }), ctx({}))],
      ['GET one', async (who) => routes.provider.GET(await request(who, '/api/llm-providers/prov-1'), ctx({ id: 'prov-1' }))],
      ['PATCH baseURL', async (who) => routes.provider.PATCH(await request(who, '/api/llm-providers/prov-1', { method: 'PATCH', body: { baseURL: 'http://evil' } }), ctx({ id: 'prov-1' }))],
      ['DELETE', async (who) => routes.provider.DELETE(await request(who, '/api/llm-providers/prov-1', { method: 'DELETE' }), ctx({ id: 'prov-1' }))],
    ];
    for (const [name, call] of cases) {
      it(`${name}: anonymous → 401, agent → 403, board session/JWT → 2xx`, async () => {
        assert.equal((await call('anon')).status, 401);
        assert.equal((await call('agent')).status, 403);
        assert.ok((await call('boardA')).status < 300);
        assert.ok((await call('jwtA')).status < 300);
      });
    }
  });

  // ---------------------------------------------------------------- models
  describe('GET /api/models', () => {
    const models = async (who: Who, qs = '') => routes.models.GET(await request(who, `/api/models${qs}`), ctx({}));
    it('anonymous → 401', async () => assert.equal((await models('anon', '?providerId=prov-1')).status, 401));
    it('agent bearer → 403', async () => assert.equal((await models('agent')).status, 403));
    it("another company's agent → 404", async () => assert.equal((await models('boardA', '?agentId=agent-b')).status, 404));
    it('board → 200 (provider, own agent, default)', async () => {
      assert.equal((await models('boardA', '?providerId=prov-1')).status, 200);
      assert.equal((await models('boardA', '?agentId=agent-a')).status, 200);
      assert.equal((await models('jwtA')).status, 200);
    });
  });

  // ---------------------------------------------------------------- agent token variants (#110/#111)
  describe('signed, forged and expired pm_run_/pm_chat_ tokens are never board', () => {
    // Every guarded route, called as an agent that ALSO carries a valid board session + board JWT.
    const calls: Array<[string, () => Promise<Response>]> = [
      ['decide', async () => routes.decide.POST(await request('agent', '/api/approvals/appr-a/decide', { method: 'POST', body: { decision: 'approved' } }), ctx({ approvalId: 'appr-a' }))],
      ['sse', async () => routes.sse.GET(await request('agent', '/api/sse/company-a'), ctx({ companyId: 'company-a' }))],
      ['mcp-tools', async () => routes.mcpTools.GET(await request('agent', '/api/agents/agent-a/mcp-tools'), ctx({ agentId: 'agent-a' }))],
      ['knowledge-graph', async () => routes.kg.GET(await request('agent', '/api/agents/agent-a/knowledge-graph'), ctx({ agentId: 'agent-a' }))],
      ['jobs live', async () => routes.live.GET(await request('agent', '/api/jobs/heartbeat/run-a/live'), ctx({ queue: 'heartbeat', jobId: 'run-a' }))],
      ['vault authorize', async () => routes.vault.GET(await request('agent', '/api/vault/oauth/authorize?serverId=github-mcp&scope=company'), ctx({}))],
      ['llm-providers list', async () => routes.providers.GET(await request('agent', '/api/llm-providers'), ctx({}))],
      ['llm-providers PATCH', async () => routes.provider.PATCH(await request('agent', '/api/llm-providers/prov-1', { method: 'PATCH', body: { baseURL: 'http://evil' } }), ctx({ id: 'prov-1' }))],
      ['models', async () => routes.models.GET(await request('agent', '/api/models?providerId=prov-1'), ctx({}))],
    ];

    for (const kind of ['run', 'chat'] as const) {
      for (const variant of ['signed', 'forged', 'expired'] as const) {
        it(`pm_${kind}_ ${variant} → 403 on every guarded route; approval untouched`, async () => {
          agentBearer = minted(kind, variant);
          assert.ok(agentBearer.startsWith(`pm_${kind}_`));
          // The variant really is what it claims under the configured secret.
          assert.equal(validateRunToken(agentBearer) !== null, variant === 'signed', `${variant} token validity`);
          for (const [name, call] of calls) {
            const res = await call();
            assert.equal(res.status, 403, `${name} with pm_${kind}_ ${variant}`);
            await res.body?.cancel();
          }
          assert.equal(store.approvals.find((a) => a.id === 'appr-a')?.status, 'pending');
        });
      }
    }
  });
});
