/**
 * #110: agent run/chat tokens must be HMAC-signed, unexpired and backed by the DB.
 * Exercised through a real agent route (GET /api/agents/me) with an in-memory db.
 * Tokens are built here with node:crypto (mirroring packages/shared/src/agent-token.ts) so the
 * file also runs against the pre-fix code.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';

const SECRET = 'test-agent-token-secret-110-0123456789abcdef';
const env = process.env as Record<string, string | undefined>;

type Row = Record<string, unknown>;
type Cond = { op: 'eq'; c: string; val: unknown } | { op: 'and'; xs: Cond[] };
const store: Record<string, Row[]> = {};
const match = (r: Row, c?: Cond): boolean =>
  !c ? true : c.op === 'eq' ? r[c.c] === c.val : c.xs.every((x) => match(r, x));
const table = (name: string) =>
  new Proxy({}, { get: (_t, prop: string) => (prop === '__table' ? name : { c: prop }) });

const b64 = (s: string) => Buffer.from(s).toString('base64url');
function signed(prefix: 'pm_run_' | 'pm_chat_', claims: Row, opts: { secret?: string; expIn?: number } = {}) {
  const iat = Math.floor(Date.now() / 1000);
  const body = `${prefix}${b64(JSON.stringify({ v: 1, ...claims, iat, exp: iat + (opts.expIn ?? 600) }))}`;
  return `${body}.${createHmac('sha256', opts.secret ?? SECRET).update(body).digest('base64url')}`;
}
const legacy = (claims: Row, prefix: 'pm_run_' | 'pm_chat_' = 'pm_run_') =>
  `${prefix}${b64(JSON.stringify({ ...claims, iat: Date.now() }))}`;
const RUN_A = { runId: 'run-a', agentId: 'agent-a', companyId: 'company-a' };

describe('#110 agent token auth (GET /api/agents/me)', () => {
  let GET: (req: NextRequest) => Promise<Response>;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    const fakeDb = {
      query: new Proxy({}, {
        get: (_t, name: string) => ({
          findFirst: async ({ where }: { where?: Cond } = {}) => {
            const row = (store[name] ?? []).find((r) => match(r, where));
            if (row && name === 'agents') return { ...row, company: { id: row.companyId }, reportsTo: null };
            return row;
          },
        }),
      }),
    };
    let realShared: Record<string, unknown> | undefined;
    Module.prototype.require = function (id: string) {
      if (id === '@tourbillon/db') return { db: fakeDb, agents: table('agents'), companies: table('companies'), heartbeatRuns: table('heartbeatRuns') };
      if (id === 'drizzle-orm') {
        return {
          eq: (col: { c: string }, val: unknown) => ({ op: 'eq', c: col.c, val }),
          and: (...xs: Cond[]) => ({ op: 'and', xs }),
        };
      }
      if (id === '@tourbillon/shared') {
        realShared ??= originalRequire.apply(this, arguments as unknown as [string]);
        return realShared;
      }
      if (id === '@/lib/agent-api-trace' || id.endsWith('/lib/agent-api-trace')) {
        return { logAgentApiRequest: () => {}, logAgentApiResponse: () => {} };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ GET } = await import('./route'));
  });

  beforeEach(() => {
    env.NODE_ENV = 'test';
    env.TOURBILLON_AGENT_TOKEN_SECRET = SECRET;
    store.agents = [
      { id: 'agent-a', companyId: 'company-a', name: 'Alice', status: 'active', runtimeConfig: {}, budgetMonthlyTokens: 0, spentMonthlyTokens: 0 },
      { id: 'agent-b', companyId: 'company-b', name: 'Bob', status: 'active', runtimeConfig: {}, budgetMonthlyTokens: 0, spentMonthlyTokens: 0 },
    ];
    store.heartbeatRuns = [
      { id: 'run-a', agentId: 'agent-a', companyId: 'company-a', status: 'running' },
      { id: 'run-done', agentId: 'agent-a', companyId: 'company-a', status: 'succeeded' },
      { id: 'run-b', agentId: 'agent-b', companyId: 'company-b', status: 'running' },
    ];
  });

  const call = (token: string) =>
    GET(new NextRequest('http://localhost/api/agents/me', { headers: { authorization: `Bearer ${token}` } }));

  it('valid signed run token for a running run → 200', async () => {
    const res = await call(signed('pm_run_', RUN_A));
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { id: string }).id, 'agent-a');
  });

  it('valid signed chat token for the agent chat session → 200', async () => {
    const res = await call(signed('pm_chat_', { chatSessionId: 'chat-agent-a', agentId: 'agent-a', companyId: 'company-a' }));
    assert.equal(res.status, 200);
  });

  it('forged legacy unsigned token → 401', async () => {
    assert.equal((await call(legacy(RUN_A))).status, 401);
  });

  it('token signed with the wrong secret → 401', async () => {
    assert.equal((await call(signed('pm_run_', RUN_A, { secret: 'attacker-guessed-secret-0123456789abcdef' }))).status, 401);
    assert.equal((await call(legacy({ ...RUN_A, runId: 'any-made-up-run' }))).status, 401);
  });

  it('tampered payload (signature kept) → 401', async () => {
    const good = signed('pm_run_', RUN_A);
    const [body, sig] = [good.slice(0, good.lastIndexOf('.')), good.slice(good.lastIndexOf('.') + 1)];
    const claims = JSON.parse(Buffer.from(body.slice('pm_run_'.length), 'base64url').toString());
    const tampered = `pm_run_${b64(JSON.stringify({ ...claims, agentId: 'agent-b', companyId: 'company-b', runId: 'run-b' }))}.${sig}`;
    assert.equal((await call(tampered)).status, 401);
    // pre-#110 format: anyone could simply write the claims they wanted
    assert.equal((await call(legacy({ runId: 'run-b', agentId: 'agent-b', companyId: 'company-b' }))).status, 401);
  });

  it('run token replayed as a chat token (prefix swap) → 401', async () => {
    const good = signed('pm_run_', RUN_A);
    assert.equal((await call(good.replace(/^pm_run_/, 'pm_chat_'))).status, 401);
    assert.equal((await call(legacy({ chatSessionId: 'chat-agent-a', agentId: 'agent-a', companyId: 'company-a' }, 'pm_chat_'))).status, 401);
  });

  it('expired token → 401', async () => {
    assert.equal((await call(signed('pm_run_', RUN_A, { expIn: -5 }))).status, 401);
    // legacy tokens had no expiry at all: a year-old token
    assert.equal((await call(`pm_run_${b64(JSON.stringify({ ...RUN_A, iat: Date.now() - 365 * 86400_000 }))}`)).status, 401);
  });

  it("finished run's token → 401", async () => {
    assert.equal((await call(signed('pm_run_', { ...RUN_A, runId: 'run-done' }))).status, 401);
    assert.equal((await call(legacy({ ...RUN_A, runId: 'run-done' }))).status, 401);
  });

  it('unknown run id → 401', async () => {
    assert.equal((await call(signed('pm_run_', { ...RUN_A, runId: 'run-nope' }))).status, 401);
    assert.equal((await call(legacy({ ...RUN_A, runId: 'run-nope' }))).status, 401);
  });

  it("cross-company: company-a token naming company-b's agent → 401", async () => {
    assert.equal((await call(signed('pm_run_', { runId: 'run-a', agentId: 'agent-b', companyId: 'company-a' }))).status, 401);
    // and a company-a run id with a company-b agent/company claim
    assert.equal((await call(signed('pm_run_', { runId: 'run-a', agentId: 'agent-b', companyId: 'company-b' }))).status, 401);
    assert.equal((await call(legacy({ runId: 'run-a', agentId: 'agent-b', companyId: 'company-b' }))).status, 401);
  });

  it("chat token for another agent's chat session → 401", async () => {
    assert.equal((await call(signed('pm_chat_', { chatSessionId: 'chat-agent-b', agentId: 'agent-a', companyId: 'company-a' }))).status, 401);
    assert.equal((await call(legacy({ chatSessionId: 'chat-agent-b', agentId: 'agent-b', companyId: 'company-b' }, 'pm_chat_'))).status, 401);
  });

  it('chat token for an archived agent → 401 (same token is 200 while the agent is active)', async () => {
    const token = signed('pm_chat_', { chatSessionId: 'chat-agent-a', agentId: 'agent-a', companyId: 'company-a' });
    assert.equal((await call(token)).status, 200);
    store.agents[0].status = 'archived';
    assert.equal((await call(token)).status, 401);
    assert.equal((await call(legacy({ chatSessionId: 'chat-agent-a', agentId: 'agent-a', companyId: 'company-a' }, 'pm_chat_'))).status, 401);
  });

  it('no secret: agent bearer → 401, the config error is logged and the log never contains the token', async () => {
    const token = signed('pm_run_', RUN_A);
    const chat = signed('pm_chat_', { chatSessionId: 'chat-agent-a', agentId: 'agent-a', companyId: 'company-a' });
    delete env.TOURBILLON_AGENT_TOKEN_SECRET;
    const logged: string[] = [];
    const original = { error: console.error, warn: console.warn, log: console.log, info: console.info };
    const capture = (...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    console.error = capture;
    console.warn = capture;
    console.log = capture;
    console.info = capture;
    try {
      assert.equal((await call(token)).status, 401);
      assert.equal((await call(chat)).status, 401);
    } finally {
      Object.assign(console, original);
    }
    assert.ok(
      logged.some((l) => l.includes('TOURBILLON_AGENT_TOKEN_SECRET is not set')),
      `config error logged (got ${JSON.stringify(logged)})`,
    );
    for (const t of [token, chat]) {
      const [body, sig] = [t.slice(0, t.lastIndexOf('.')), t.slice(t.lastIndexOf('.') + 1)];
      assert.ok(logged.every((l) => !l.includes(body) && !l.includes(sig)), 'log never contains the token');
    }
  });

  it('no secret configured (production) → fails closed, even for a correctly signed token', async () => {
    const token = signed('pm_run_', RUN_A);
    delete env.TOURBILLON_AGENT_TOKEN_SECRET;
    env.NODE_ENV = 'production';
    assert.equal((await call(token)).status, 401);
    assert.equal((await call(legacy(RUN_A))).status, 401);
  });
});
