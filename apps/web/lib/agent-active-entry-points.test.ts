/**
 * #119 B1: every entry point that sets an agent active goes through lib/agents.ts setAgentActive,
 * which refuses to activate an archived agent (that would revive its run/chat tokens).
 * Entry points: detail chip (setAgentActiveAction), list toggle (toggleAgentActiveAction),
 * MCP tools/call set_agent_active, mobile PATCH /api/mobile/agents/[urlKey] section 'active'.
 *
 * The REAL lib/agents.ts, lib/company.ts, lib/board-auth.ts, lib/mobile-auth.ts, the real actions
 * and both real route handlers run against a small in-memory agents/companies table
 * (@tourbillon/db and drizzle-orm are faked); heavy unrelated libs are stubbed. All values are fakes.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';

const JWT_SECRET = 'test-better-auth-secret-not-default';
process.env.BETTER_AUTH_SECRET = JWT_SECRET;
process.env.TOURBILLON_BOARD_SECRET = 'test-operator-secret-b1';
delete process.env.TOURBILLON_BOARD_AUTH_INSECURE_DEV;

type Row = Record<string, unknown> & { id: string; companyId: string; urlKey: string; status: string };
let rows: Row[];
let writes: Array<Record<string, unknown>>;
const companyRows = [{ id: 'company-a', name: 'Company A', allowedMcpServerIds: [], settings: {} }];
const reqState: { cookies: Record<string, string>; headers: Record<string, string> } = { cookies: {}, headers: {} };

function agentRow(id: string, urlKey: string, status: string): Row {
  return {
    id,
    urlKey,
    status,
    companyId: 'company-a',
    name: id,
    title: 'Fixture',
    role: 'engineer',
    adapterType: 'lmstudio',
    modelId: 'model-1',
    providerId: null,
    reportsToId: null,
    assignedSkills: [],
    assignedToolsets: [],
    mcpServerIds: [],
    budgetMonthlyTokens: 0,
    spentMonthlyTokens: 0,
    runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300 } },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

// --- in-memory drizzle-ish fake -------------------------------------------------------------
type Pred = (row: Record<string, unknown>) => boolean;
const col = (name: string) => ({ __col: name });
const table = (cols: string[]) => Object.fromEntries(cols.map((c) => [c, col(c)]));
const fakeDrizzle = new Proxy(
  {
    eq: (c: { __col: string }, v: unknown): Pred => (r) => r[c.__col] === v,
    and: (...ps: Pred[]): Pred => (r) => ps.every((p) => p(r)),
  } as Record<string, unknown>,
  { get: (t, k) => (k in t ? t[k as string] : () => () => true) },
);
const fakeDb = {
  agents: table(['id', 'companyId', 'urlKey', 'status', 'reportsToId']),
  companies: table(['id']),
  db: {
    query: {
      agents: { findFirst: async ({ where }: { where: Pred }) => rows.find(where) },
      companies: { findFirst: async ({ where }: { where: Pred }) => companyRows.find(where) },
    },
    update: () => ({
      set: (payload: Record<string, unknown>) => ({
        where: (pred: Pred) => ({
          returning: async () => {
            writes.push(payload);
            const hit = rows.filter(pred);
            hit.forEach((r) => Object.assign(r, payload));
            return hit.map((r) => ({ ...r }));
          },
        }),
      }),
    }),
  },
};
const asyncStub = () => new Proxy({}, { get: (_t, k) => (k === '__esModule' ? true : async () => null) });

describe('#119 B1: archived agents cannot be activated through any entry point', () => {
  let chipAction: typeof import('../app/(dashboard)/agent/actions').setAgentActiveAction;
  let listAction: typeof import('../app/(dashboard)/agent/actions').toggleAgentActiveAction;
  let mcpPOST: (req: NextRequest) => Promise<Response>;
  let mobilePATCH: (req: NextRequest, ctx: { params: Promise<{ urlKey: string }> }) => Promise<Response>;
  let createBoardSessionToken: typeof import('./board-auth').createBoardSessionToken;
  let boardJwt: string;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    const STUBBED = new Set([
      '@tourbillon/mastra',
      '@/lib/heartbeats',
      '@/lib/heartbeat',
      '@/lib/observability',
      '@/lib/jobs',
      '@/lib/issues',
      '@/lib/goals',
      '@/lib/projects',
      '@/lib/issue-comments',
      '@/lib/wake-client',
      '@/lib/llm-providers',
      './llm-providers',
      './chat',
    ]);
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      if (id === '@tourbillon/db') return fakeDb;
      if (id === 'drizzle-orm') return fakeDrizzle;
      if (STUBBED.has(id)) return asyncStub();
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
      if (id === 'next/cache') return { revalidatePath: () => {} };
      if (id === 'next/navigation') {
        return { redirect: (url: string) => { throw new Error(`redirect:${url}`); } };
      }
      // lib/company.ts would create company workspace dirs on disk; keep it in memory.
      if (id === '@tourbillon/shared' && this.filename?.endsWith('/lib/company.ts')) {
        return { ensureCompanyWorkspace: async () => {}, mergeCompanySettings: (a: unknown) => a, parseCompanySettings: (a: unknown) => a };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ setAgentActiveAction: chipAction, toggleAgentActiveAction: listAction } = await import(
      '../app/(dashboard)/agent/actions'
    ));
    ({ POST: mcpPOST } = (await import('../app/api/mcp/route')) as never);
    ({ PATCH: mobilePATCH } = (await import('../app/api/mobile/agents/[urlKey]/route')) as never);
    ({ createBoardSessionToken } = await import('./board-auth'));
    boardJwt = await new SignJWT({ companyId: 'company-a' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(JWT_SECRET));
  });

  beforeEach(async () => {
    rows = [agentRow('agent-arch', 'arch', 'archived'), agentRow('agent-off', 'off', 'paused')];
    writes = [];
    reqState.headers = {};
    reqState.cookies = { tourbillon_board_session: (await createBoardSessionToken())! };
  });

  const status = (id: string) => rows.find((r) => r.id === id)!.status;
  const ARCHIVED_MSG = 'Agent is archived and cannot be activated.';

  async function mcpSetActive(agentId: string, active: boolean) {
    const res = await mcpPOST(
      new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-company-token': boardJwt },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'set_agent_active', arguments: { company_id: 'company-a', agent_id: agentId, active } },
        }),
      }),
    );
    return { http: res.status, body: (await res.json()) as { error?: { code: number; message: string }; result?: unknown } };
  }

  async function mobileSetActive(urlKey: string, active: boolean) {
    const res = await mobilePATCH(
      new NextRequest(`http://localhost/api/mobile/agents/${urlKey}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-company-token': boardJwt },
        body: JSON.stringify({ section: 'active', active }),
      }),
      { params: Promise.resolve({ urlKey }) },
    );
    return { http: res.status, body: (await res.json()) as { error?: string; agent?: { status: string } } };
  }

  function listForm(agentId: string, active: boolean) {
    const fd = new FormData();
    fd.set('agentId', agentId);
    fd.set('active', String(active));
    return fd;
  }

  it('detail chip action: archived → active refused with 400 + clear message (toast), no write', async () => {
    assert.deepEqual(await chipAction('agent-arch', true, 'arch'), { ok: false, status: 400, error: ARCHIVED_MSG });
    assert.equal(status('agent-arch'), 'archived');
    assert.deepEqual(writes, []);
  });

  it('detail chip action: deactivating an archived agent is a no-op (stays archived, no write)', async () => {
    assert.deepEqual(await chipAction('agent-arch', false, 'arch'), { ok: true, active: false, status: 'archived' });
    assert.equal(status('agent-arch'), 'archived');
    assert.deepEqual(writes, []);
  });

  it('list toggle action: archived → active redirects to /agent with the error, no write', async () => {
    await assert.rejects(() => listAction(listForm('agent-arch', true)), {
      message: `redirect:/agent?error=${encodeURIComponent(ARCHIVED_MSG)}`,
    });
    assert.equal(status('agent-arch'), 'archived');
    assert.deepEqual(writes, []);
  });

  it('mobile PATCH section active: archived → active is 400 with the message, no write', async () => {
    const res = await mobileSetActive('arch', true);
    assert.equal(res.http, 400);
    assert.equal(res.body.error, ARCHIVED_MSG);
    assert.equal(status('agent-arch'), 'archived');
    assert.deepEqual(writes, []);
  });

  it('MCP set_agent_active: archived → active is a JSON-RPC tool error with the message, no write', async () => {
    const res = await mcpSetActive('agent-arch', true);
    assert.equal(res.body.error?.code, -32000);
    assert.equal(res.body.error?.message, ARCHIVED_MSG);
    assert.equal(res.body.result, undefined);
    assert.equal(status('agent-arch'), 'archived');
    assert.deepEqual(writes, []);
  });

  it('controls: the same paths still activate a paused (inactive) agent', async () => {
    assert.deepEqual(await chipAction('agent-off', true, 'off'), { ok: true, active: true, status: 'active' });
    rows[1].status = 'paused';
    await listAction(listForm('agent-off', true));
    assert.equal(status('agent-off'), 'active');
    rows[1].status = 'paused';
    const mobile = await mobileSetActive('off', true);
    assert.equal(mobile.http, 200);
    assert.equal(mobile.body.agent?.status, 'active');
    rows[1].status = 'paused';
    const mcp = await mcpSetActive('agent-off', true);
    assert.equal(mcp.body.error, undefined);
    assert.equal(status('agent-off'), 'active');
    assert.equal(writes.length, 4);
  });
});
