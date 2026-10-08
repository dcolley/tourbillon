/**
 * Board 'Archive agent': POST /api/agents/:agentId/archive and archiveAgentAction (agent page).
 * Auth and company scoping only; the archive itself (status, timer, run kill, idempotency) is
 * covered by lib/agent-archive.test.ts. Real proxy.ts, board-route-auth, company, board-auth and
 * mobile-auth; next/headers, @tourbillon/db and @/lib/agent-archive are mocked. All values are fakes.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { mintChatToken, mintRunToken } from '@tourbillon/shared/agent-token';

const BOARD_SECRET = 'test-operator-secret-archive';
const JWT_SECRET = 'test-better-auth-secret-archive-board-jwt-0123456789';
const AGENT_TOKEN_SECRET = 'test-agent-token-secret-archive-route-0123456789';
const env = process.env as Record<string, string | undefined>;
env.BETTER_AUTH_SECRET = JWT_SECRET;
env.TOURBILLON_BOARD_SECRET = BOARD_SECRET;
env.TOURBILLON_AGENT_TOKEN_SECRET = AGENT_TOKEN_SECRET;
delete env.TOURBILLON_BOARD_AUTH_INSECURE_DEV;

const companies = new Map([
  ['company-a', { id: 'company-a', name: 'A' }],
  ['company-b', { id: 'company-b', name: 'B' }],
]);
type MockAgent = { id: string; urlKey: string; companyId: string; status: string };
let agents: MockAgent[];
let archiveCalls: Array<[string, string]>;
let revalidated: string[];
const reqState: { cookies: Record<string, string>; headers: Record<string, string> } = { cookies: {}, headers: {} };

function sessionToken() {
  const key = new Uint8Array(createHmac('sha256', 'tourbillon-board-session-v1').update(BOARD_SECRET).digest());
  return new SignJWT({ typ: 'tourbillon_board_session' }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h').sign(key);
}
function boardJwt(companyId: string) {
  return new SignJWT({ companyId }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));
}
const RUN_TOKEN = mintRunToken({ runId: 'run-1', agentId: 'agent-a1', companyId: 'company-a' }, 600);
const CHAT_TOKEN = mintChatToken({ chatSessionId: 'chat-agent-a1', agentId: 'agent-a1', companyId: 'company-a' });
const LEGACY_RUN_TOKEN = `pm_run_${Buffer.from(JSON.stringify({ runId: 'r', agentId: 'agent-a1', companyId: 'company-a', iat: 1 })).toString('base64url')}`;

type Who = 'anon' | 'boardA' | 'jwtA' | 'jwtB' | { agentBearer: string };
async function setRequest(who: Who): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  if (who === 'boardA' || typeof who === 'object') {
    cookies.tourbillon_board_session = await sessionToken();
    cookies.active_company_id = 'company-a';
  }
  if (typeof who === 'object') {
    // Agent bearer alongside a valid board session, company cookie and board JWT: still never board.
    headers.authorization = `Bearer ${who.agentBearer}`;
    headers['x-company-token'] = await boardJwt('company-a');
  }
  if (who === 'jwtA') headers['x-company-token'] = await boardJwt('company-a');
  if (who === 'jwtB') headers['x-company-token'] = await boardJwt('company-b');
  if (Object.keys(cookies).length) headers.cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  reqState.cookies = cookies;
  reqState.headers = headers;
  return headers;
}

describe('Archive agent: board-only route + server action', () => {
  let POST: (req: NextRequest, c: { params: Promise<{ agentId: string }> }) => Promise<Response>;
  let archiveAgentAction: typeof import('../../../../(dashboard)/agent/archive-action').archiveAgentAction;
  let proxy: typeof import('../../../../../proxy').proxy;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    let realShared: Record<string, unknown> | undefined;
    Module.prototype.require = function (id: string) {
      if (id === 'next/headers') {
        return {
          cookies: async () => ({
            get: (n: string) => (n in reqState.cookies ? { name: n, value: reqState.cookies[n] } : undefined),
            set: () => {},
            delete: () => {},
          }),
          headers: async () => new Headers(reqState.headers),
        };
      }
      if (id === 'next/cache') return { revalidatePath: (p: string) => revalidated.push(p) };
      if (id === '@tourbillon/db') {
        return {
          companies: { id: 'id' },
          db: { query: { companies: { findFirst: async ({ where }: { where: { val: string } }) => companies.get(where.val) } } },
        };
      }
      if (id === 'drizzle-orm') return { eq: (_c: unknown, val: unknown) => ({ val }), and: () => ({}), asc: (c: unknown) => c };
      if (id === '@tourbillon/shared') {
        realShared ??= originalRequire.apply(this, arguments as unknown as [string]);
        return { ...realShared, ensureCompanyWorkspace: async () => {} };
      }
      if (id === '@/lib/agent-archive' || id.endsWith('/lib/agent-archive')) {
        return {
          // Mirrors lib/agent-archive.ts: lookup by id or urlKey inside companyId only.
          archiveAgent: async (key: string, companyId: string) => {
            archiveCalls.push([key, companyId]);
            const agent = agents.find((a) => a.companyId === companyId && (a.id === key || a.urlKey === key));
            if (!agent) return null;
            const changed = agent.status !== 'archived';
            agent.status = 'archived';
            return {
              agent: { ...agent, runtimeConfig: { heartbeat: { enabled: false } } },
              changed,
              timerSync: 'synced',
              runs: changed ? [{ runId: 'run-1', outcome: 'aborted' }] : [],
            };
          },
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ POST } = await import('./route'));
    ({ archiveAgentAction } = await import('../../../../(dashboard)/agent/archive-action'));
    ({ proxy } = await import('../../../../../proxy'));
  });

  beforeEach(() => {
    agents = [
      { id: 'agent-a1', urlKey: 'worker', companyId: 'company-a', status: 'active' },
      { id: 'agent-b1', urlKey: 'other', companyId: 'company-b', status: 'active' },
    ];
    archiveCalls = [];
    revalidated = [];
  });

  async function post(who: Who, agentId: string) {
    const headers = await setRequest(who);
    const req = new NextRequest(`http://localhost/api/agents/${agentId}/archive`, { method: 'POST', headers });
    return POST(req, { params: Promise.resolve({ agentId }) });
  }

  it('route: anonymous → 401, nothing archived', async () => {
    const res = await post('anon', 'agent-a1');
    assert.equal(res.status, 401);
    assert.deepEqual(archiveCalls, []);
    assert.equal(agents[0].status, 'active');
  });

  it('route: agent bearer (signed run/chat, legacy) with board session + JWT → 403, nothing archived', async () => {
    for (const token of [RUN_TOKEN, CHAT_TOKEN, LEGACY_RUN_TOKEN]) {
      const res = await post({ agentBearer: token }, 'agent-a1');
      assert.equal(res.status, 403, token.slice(0, 8));
    }
    assert.deepEqual(archiveCalls, []);
    assert.equal(agents[0].status, 'active');
  });

  it('route: board of another company → 404 (scoped lookup), nothing archived', async () => {
    const res = await post('jwtB', 'agent-a1');
    assert.equal(res.status, 404);
    assert.deepEqual(archiveCalls, [['agent-a1', 'company-b']]);
    assert.equal(agents[0].status, 'active');
    const byKey = await post('boardA', 'other');
    assert.equal(byKey.status, 404);
    assert.equal(agents[1].status, 'active');
  });

  it('route: board session or board JWT → 200 archived; re-archive → 200 changed:false', async () => {
    const res = await post('boardA', 'agent-a1');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.archived, true);
    assert.equal(body.changed, true);
    assert.equal(body.heartbeatTimerActive, false);
    assert.deepEqual(body.runs, [{ runId: 'run-1', outcome: 'aborted' }]);
    assert.deepEqual(archiveCalls, [['agent-a1', 'company-a']]);
    const again = await post('jwtA', 'worker');
    assert.equal(again.status, 200);
    const againBody = await again.json();
    assert.equal(againBody.archived, true);
    assert.equal(againBody.changed, false);
  });

  it('action: agent bearer + board session → 401 from the proxy before the action runs', async () => {
    for (const token of [RUN_TOKEN, CHAT_TOKEN]) {
      const headers = await setRequest({ agentBearer: token });
      const res = await proxy(new NextRequest('http://localhost/agent/worker', { method: 'POST', headers: { ...headers, 'next-action': 'archive' } }));
      assert.equal(res.status, 401);
    }
    const anon = await proxy(new NextRequest('http://localhost/agent/worker', { method: 'POST', headers: { 'next-action': 'archive' } }));
    assert.equal(anon.status, 401);
  });

  it('action itself: no board session, or an agent bearer → BoardSessionRequiredError, nothing archived', async () => {
    await setRequest('anon');
    await assert.rejects(() => archiveAgentAction('agent-a1', 'worker'), { name: 'BoardSessionRequiredError' });
    for (const token of [RUN_TOKEN, CHAT_TOKEN]) {
      await setRequest({ agentBearer: token });
      await assert.rejects(() => archiveAgentAction('agent-a1', 'worker'), { name: 'BoardSessionRequiredError' });
    }
    assert.deepEqual(archiveCalls, []);
    assert.equal(agents[0].status, 'active');
  });

  it('action: board session archives in the active company; another company\'s agent → 404', async () => {
    await setRequest('boardA');
    assert.deepEqual(await archiveAgentAction('agent-b1'), { ok: false, status: 404, error: 'Agent not found.' });
    assert.equal(agents[1].status, 'active');
    const res = await archiveAgentAction('agent-a1', 'worker');
    assert.deepEqual(res, { ok: true, changed: true, runsStopped: 1, timerSync: 'synced' });
    assert.deepEqual(archiveCalls, [['agent-b1', 'company-a'], ['agent-a1', 'company-a']]);
    assert.deepEqual(revalidated, ['/agent', '/agent/worker']);
    // Idempotent: archiving again is a no-op success.
    assert.deepEqual(await archiveAgentAction('agent-a1', 'worker'), { ok: true, changed: false, runsStopped: 0, timerSync: 'synced' });
  });

  it('action: board session without an active company → 401; blank id → 400', async () => {
    await setRequest('boardA');
    delete reqState.cookies.active_company_id;
    assert.deepEqual(await archiveAgentAction('agent-a1'), { ok: false, status: 401, error: 'Unauthorized' });
    assert.deepEqual(await archiveAgentAction('  '), { ok: false, status: 400, error: 'Agent ID is required.' });
    assert.deepEqual(archiveCalls, []);
  });
});
