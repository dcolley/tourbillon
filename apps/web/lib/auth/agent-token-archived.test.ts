/**
 * #120: archiving an agent must make its agent tokens fail closed at once, on every agent-bearer
 * route. Before the fix only chat tokens were refused; a run token kept working while its
 * heartbeat run was still 'running' (up to the ~23h #111 cap).
 *
 * Shared validator (authenticateAgentToken) plus three real agent-bearer routes:
 * GET /api/agents/me, GET /api/agents/me/inbox-lite, GET /api/issues/[issueId]/heartbeat-context.
 * In-memory db; tokens are minted with the real signer.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { mintChatToken, mintRunToken } from '@tourbillon/shared/agent-token';

const SECRET = 'test-agent-token-secret-120-0123456789abcdef';
const env = process.env as Record<string, string | undefined>;

type Row = Record<string, unknown>;
type Cond =
  | { op: 'eq'; c: string; val: unknown }
  | { op: 'and'; xs: Cond[] }
  | { op: 'in'; c: string; vals: unknown[] }
  | { op: 'null'; c: string };
const store: Record<string, Row[]> = {};
let dbThrows = false;
const match = (r: Row, c?: Cond): boolean => {
  if (!c) return true;
  if (c.op === 'eq') return r[c.c] === c.val;
  if (c.op === 'in') return c.vals.includes(r[c.c]);
  if (c.op === 'null') return r[c.c] == null;
  return c.xs.every((x) => match(r, x));
};
const table = (name: string) =>
  new Proxy({}, { get: (_t, prop: string) => (prop === '__table' ? name : { c: prop }) });
const nameOf = (t: unknown) => (t as { __table: string }).__table;

const A = { agentId: 'agent-a', companyId: 'company-a' };
const runToken = () => mintRunToken({ runId: 'run-a', ...A }, 600);
const chatToken = () => mintChatToken({ chatSessionId: 'chat-agent-a', ...A }, 600);

type Get = (req: NextRequest, ctx?: unknown) => Promise<Response>;

describe('#120 archived agents: run and chat tokens fail closed', () => {
  let authenticateAgentToken: (t: string | null | undefined) => Promise<unknown>;
  const routes: Record<string, Get> = {};

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    const fakeDb = {
      query: new Proxy({}, {
        get: (_t, name: string) => ({
          findFirst: async ({ where }: { where?: Cond } = {}) => {
            if (dbThrows) throw new Error('db down');
            const row = (store[name] ?? []).find((r) => match(r, where));
            if (row && name === 'agents') return { ...row, company: { id: row.companyId }, reportsTo: null };
            return row;
          },
        }),
      }),
      select: () => ({
        from: (t: unknown) => ({ where: async (cond: Cond) => (store[nameOf(t)] ?? []).filter((r) => match(r, cond)) }),
      }),
    };
    const is = (id: string, name: string) => id === `@/lib/${name}` || id.endsWith(`/lib/${name}`);
    Module.prototype.require = function (id: string) {
      if (id === '@tourbillon/db') {
        return {
          db: fakeDb,
          agents: table('agents'),
          companies: table('companies'),
          heartbeatRuns: table('heartbeatRuns'),
          issues: table('issues'),
          goals: table('goals'),
          projects: table('projects'),
        };
      }
      if (id === 'drizzle-orm') {
        return {
          eq: (col: { c: string }, val: unknown) => ({ op: 'eq', c: col.c, val }),
          and: (...xs: Cond[]) => ({ op: 'and', xs }),
          inArray: (col: { c: string }, vals: unknown[]) => ({ op: 'in', c: col.c, vals }),
          isNull: (col: { c: string }) => ({ op: 'null', c: col.c }),
        };
      }
      if (is(id, 'agent-api-trace')) return { logAgentApiRequest: () => {}, logAgentApiResponse: () => {} };
      if (is(id, 'issue-comments')) return { countIssueComments: async () => 2, getLatestIssueActivityId: async () => 'c-1' };
      if (is(id, 'review-routing')) return { resolveReviewAssignee: async () => null };
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ authenticateAgentToken } = await import('./agent-token-auth'));
    routes.me = (await import('../../app/api/agents/me/route')).GET as Get;
    routes.inbox = (await import('../../app/api/agents/me/inbox-lite/route')).GET as Get;
    routes.heartbeatContext = (await import('../../app/api/issues/[issueId]/heartbeat-context/route')).GET as Get;
    Module.prototype.require = originalRequire;
  });

  beforeEach(() => {
    env.NODE_ENV = 'test';
    env.TOURBILLON_AGENT_TOKEN_SECRET = SECRET;
    dbThrows = false;
    store.agents = [
      { id: 'agent-a', companyId: 'company-a', name: 'Alice', role: 'engineer', status: 'active', runtimeConfig: {}, budgetMonthlyTokens: 0, spentMonthlyTokens: 0 },
    ];
    // The heartbeat run is still running: the mid-run archive case from #120.
    store.heartbeatRuns = [{ id: 'run-a', agentId: 'agent-a', companyId: 'company-a', status: 'running' }];
    store.issues = [
      {
        id: 'issue-1', identifier: 'TB-1', title: 'T', description: '', status: 'in_progress', priority: 'medium',
        parentId: null, goalId: null, boardApprovalId: null, blockedByIssueIds: [], companyId: 'company-a',
        assigneeAgentId: 'agent-a', goal: null, project: null,
      },
    ];
  });

  const bearer = (token: string, path: string) =>
    new NextRequest(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } });
  const calls: Array<[string, (token: string) => Promise<Response>]> = [
    ['GET /api/agents/me', (t) => routes.me(bearer(t, '/api/agents/me'))],
    ['GET /api/agents/me/inbox-lite', (t) => routes.inbox(bearer(t, '/api/agents/me/inbox-lite'))],
    [
      'GET /api/issues/[issueId]/heartbeat-context',
      (t) => routes.heartbeatContext(bearer(t, '/api/issues/issue-1/heartbeat-context'), { params: Promise.resolve({ issueId: 'issue-1' }) }),
    ],
  ];
  const archive = () => {
    store.agents[0].status = 'archived';
  };

  // --------------------------------------------------------------- shared validator
  describe('authenticateAgentToken', () => {
    for (const [kind, mint] of [['run', runToken], ['chat', chatToken]] as const) {
      it(`${kind} token: accepted while active, null once the agent is archived (run still running)`, async () => {
        const token = mint();
        assert.equal(((await authenticateAgentToken(token)) as { kind: string } | null)?.kind, kind);
        archive();
        assert.equal(store.heartbeatRuns[0].status, 'running');
        assert.equal(await authenticateAgentToken(token), null);
      });
    }

    it('non-archived statuses are unchanged: paused and pending_approval still pass (#116 is separate)', async () => {
      for (const status of ['paused', 'pending_approval']) {
        store.agents[0].status = status;
        assert.ok(await authenticateAgentToken(runToken()), `run token, ${status}`);
        assert.ok(await authenticateAgentToken(chatToken()), `chat token, ${status}`);
      }
    });

    it('DB error handling is unchanged: a failed lookup → null', async () => {
      dbThrows = true;
      assert.equal(await authenticateAgentToken(runToken()), null);
      assert.equal(await authenticateAgentToken(chatToken()), null);
    });
  });

  // --------------------------------------------------------------- agent-bearer routes
  for (const [name, call] of calls) {
    describe(name, () => {
      it('run and chat tokens → 200 for a non-archived agent', async () => {
        assert.equal((await call(runToken())).status, 200);
        assert.equal((await call(chatToken())).status, 200);
      });

      it('run token minted before archiving → 401 after, while its run is still running', async () => {
        const token = runToken();
        assert.equal((await call(token)).status, 200);
        archive();
        const res = await call(token);
        assert.equal(res.status, 401);
        assert.ok(!('id' in ((await res.json()) as Row)), 'no agent data leaks');
      });

      it('chat token minted before archiving → 401 after', async () => {
        const token = chatToken();
        assert.equal((await call(token)).status, 200);
        archive();
        assert.equal((await call(token)).status, 401);
      });
    });
  }
});
