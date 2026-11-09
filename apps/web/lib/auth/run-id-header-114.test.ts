/**
 * #114: `X-Paperclip-Run-Id` must never replace the signed run identity.
 *
 * Exercises the three agent write routes that used to read the header (issue checkout, issue
 * comment create, issue PATCH) through the real handlers + real token auth, with an in-memory db
 * (MOCKED persistence, not Postgres). For every route: token for run A plus a header naming
 * another real run (same agent / other agent same company / other company / finished / unknown /
 * empty) → fixed 403 `run_id_mismatch` and the whole store is byte-identical afterwards (no lock,
 * issue, comment or activity write, no wake). Positives: header absent or equal to A → the action
 * is attributed to run A only. Existing lock and tenant denials are unchanged.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';

const SECRET = 'test-agent-token-secret-114-0123456789abcdef';
const env = process.env as Record<string, string | undefined>;

type Row = Record<string, unknown>;
type Cond = { op: 'eq'; c: string; val: unknown } | { op: 'and'; xs: Cond[] };
const store: Record<string, Row[]> = {};
let wakes: unknown[] = [];
let seq = 0;
const match = (r: Row, c?: Cond): boolean =>
  !c ? true : c.op === 'eq' ? r[c.c] === c.val : c.xs.every((x) => match(r, x));
const table = (name: string) =>
  new Proxy({}, { get: (_t, prop: string) => (prop === '__table' ? name : { c: prop }) });
const tname = (t: unknown) => (t as { __table: string }).__table;

const b64 = (s: string) => Buffer.from(s).toString('base64url');
function signed(prefix: 'pm_run_' | 'pm_chat_', claims: Row) {
  const iat = Math.floor(Date.now() / 1000);
  const body = `${prefix}${b64(JSON.stringify({ v: 1, ...claims, iat, exp: iat + 600 }))}`;
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}
const tokenFor = (runId: string, agentId: string, companyId: string) => signed('pm_run_', { runId, agentId, companyId });
const TOKEN_A = () => tokenFor('run-a', 'agent-a1', 'company-a');
const CHAT_A = () => signed('pm_chat_', { chatSessionId: 'chat-agent-a1', agentId: 'agent-a1', companyId: 'company-a' });

const fakeDb = {
  query: new Proxy({}, {
    get: (_t, name: string) => ({
      findFirst: async ({ where }: { where?: Cond } = {}) => {
        const row = (store[name] ?? []).find((r) => match(r, where));
        return row ? structuredClone(row) : undefined;
      },
    }),
  }),
  update: (t: unknown) => ({
    set: (vals: Row) => ({
      where: (where: Cond) => {
        const rows = (store[tname(t)] ?? []).filter((r) => match(r, where));
        for (const r of rows) Object.assign(r, vals);
        const out = rows.map((r) => structuredClone(r));
        return Object.assign(Promise.resolve(out), { returning: async () => out });
      },
    }),
  }),
  insert: (t: unknown) => ({
    values: (vals: Row) => {
      const row = { id: `row-${++seq}`, createdAt: new Date(0), ...vals };
      (store[tname(t)] ??= []).push(row);
      return Object.assign(Promise.resolve([row]), { returning: async () => [structuredClone(row)] });
    },
  }),
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb),
};

function seed() {
  seq = 0;
  wakes = [];
  const agent = (id: string, companyId: string) => ({ id, companyId, name: id, status: 'active', runtimeConfig: {} });
  store.agents = [agent('agent-a1', 'company-a'), agent('agent-a2', 'company-a'), agent('agent-b1', 'company-b')];
  store.heartbeatRuns = [
    { id: 'run-a', agentId: 'agent-a1', companyId: 'company-a', status: 'running' },
    { id: 'run-b', agentId: 'agent-a1', companyId: 'company-a', status: 'running' }, // same agent, other run
    { id: 'run-c', agentId: 'agent-a2', companyId: 'company-a', status: 'running' }, // other agent, same company
    { id: 'run-d', agentId: 'agent-b1', companyId: 'company-b', status: 'running' }, // other company
    { id: 'run-done', agentId: 'agent-a1', companyId: 'company-a', status: 'succeeded' },
  ];
  const issue = (id: string, companyId: string, lock?: { run: string; agent: string }) => ({
    id, companyId, identifier: id.toUpperCase(), title: id, status: lock ? 'in_progress' : 'todo', priority: 'medium',
    assigneeAgentId: lock?.agent ?? 'agent-a1', assigneeUserId: null, boardApprovalId: null, blockedByIssueIds: [],
    checkoutRunId: lock?.run ?? null, executionLockedAt: lock ? new Date(0) : null,
    executionAgentNameKey: lock?.agent ?? null, startedAt: lock ? new Date(0) : null, updatedAt: new Date(0),
  });
  store.issues = [
    issue('iss-free', 'company-a'),
    issue('iss-b', 'company-a', { run: 'run-b', agent: 'agent-a1' }),
    issue('iss-c', 'company-a', { run: 'run-c', agent: 'agent-a2' }),
    issue('iss-d', 'company-b', { run: 'run-d', agent: 'agent-b1' }),
    issue('iss-d-free', 'company-b'),
  ];
  store.activityLog = [];
}
const snapshot = () => JSON.stringify({ store, wakes });

type Handler = (req: NextRequest, ctx: { params: Promise<{ issueId: string }> }) => Promise<Response>;
const routes: Record<string, { method: string; path: (id: string) => string; body: Row; handler?: Handler }> = {
  checkout: { method: 'POST', path: (id) => `/api/issues/${id}/checkout`, body: { agentId: 'agent-a1', expectedStatuses: ['todo', 'in_progress'] } },
  comment: { method: 'POST', path: (id) => `/api/issues/${id}/comments`, body: { body: 'synthetic comment 114' } },
  patch: { method: 'PATCH', path: (id) => `/api/issues/${id}`, body: { status: 'in_review', assigneeAgentId: 'agent-a2', comment: 'synthetic 114' } },
};

async function call(route: keyof typeof routes, issueId: string, token: string, header?: string) {
  const r = routes[route];
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if (header !== undefined) headers['x-paperclip-run-id'] = header;
  const req = new NextRequest(`http://localhost${r.path(issueId)}`, { method: r.method, headers, body: JSON.stringify(r.body) });
  return r.handler!(req, { params: Promise.resolve({ issueId }) });
}

describe('#114 X-Paperclip-Run-Id never replaces the signed run id', () => {
  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (id: string) {
      if (id === '@tourbillon/db') {
        return {
          db: fakeDb,
          agents: table('agents'), issues: table('issues'), activityLog: table('activityLog'),
          heartbeatRuns: table('heartbeatRuns'), companies: table('companies'),
          shouldInsertCheckoutActivity: (issue: Row, agentId: string) =>
            issue.status !== 'in_progress' || issue.executionAgentNameKey !== agentId,
          CHECKOUT_LOCK_CLEAR_FIELDS: { checkoutRunId: null, executionLockedAt: null, executionAgentNameKey: null },
          statusesThatReleaseCheckoutLock: (s: string) => ['done', 'cancelled', 'in_review', 'blocked', 'todo', 'backlog'].includes(s),
          isStaleCheckoutRun: async (runId: string) =>
            (store.heartbeatRuns.find((r) => r.id === runId)?.status ?? 'missing') !== 'running',
          releaseStaleCheckoutLocksForRun: async () => 0,
        };
      }
      if (id === 'drizzle-orm') {
        return {
          eq: (col: { c: string }, val: unknown) => ({ op: 'eq', c: col.c, val }),
          and: (...xs: Cond[]) => ({ op: 'and', xs }),
          asc: () => null, desc: () => null, gt: () => null, or: () => null,
        };
      }
      if (id === '@/lib/agent-api-trace' || id.endsWith('/lib/agent-api-trace')) {
        return { logAgentApiRequest: () => {}, logAgentApiResponse: () => {}, summarizeBody: (b: unknown) => b };
      }
      if (id === '@/lib/wake-client' || id.endsWith('/lib/wake-client')) {
        return { enqueueHeartbeat: async (w: unknown) => { wakes.push(w); } };
      }
      if (id === '@/lib/review-routing' || id.endsWith('/lib/review-routing')) {
        return { resolveReviewAssignee: async () => null };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    routes.checkout.handler = (await import('../../app/api/issues/[issueId]/checkout/route')).POST as Handler;
    routes.comment.handler = (await import('../../app/api/issues/[issueId]/comments/route')).POST as Handler;
    routes.patch.handler = (await import('../../app/api/issues/[issueId]/route')).PATCH as Handler;
  });

  beforeEach(() => {
    env.TOURBILLON_AGENT_TOKEN_SECRET = SECRET;
    seed();
  });

  const MISMATCH = ['run-b', 'run-c', 'run-d', 'run-done', 'run-unknown', '', 'run-a2', 'chat-agent-a1'];
  const TARGETS = ['iss-free', 'iss-b', 'iss-c', 'iss-d'];

  for (const route of Object.keys(routes) as (keyof typeof routes)[]) {
    describe(route, () => {
      for (const header of MISMATCH) {
        it(`token A + header ${JSON.stringify(header)} → 403 run_id_mismatch, no mutation, on every target`, async () => {
          for (const target of TARGETS) {
            const before = snapshot();
            const res = await call(route, target, TOKEN_A(), header);
            assert.equal(res.status, 403, `${route} ${target}`);
            assert.equal(((await res.json()) as { code?: string }).code, 'run_id_mismatch');
            assert.equal(snapshot(), before, `${route} ${target}: store unchanged`);
          }
        });
      }

      for (const header of [undefined, 'run-a']) {
        it(`token A + header ${header ?? '(absent)'} on an available issue → success attributed to run A only`, async () => {
          const res = await call(route, 'iss-free', TOKEN_A(), header);
          assert.ok(res.status === 200 || res.status === 201, `status ${res.status}`);
          const acts = store.activityLog;
          assert.ok(acts.length >= 1, 'activity written');
          for (const a of acts) {
            assert.equal(a.actorId, 'agent-a1');
            assert.equal((a.details as Row).runId, 'run-a');
          }
          if (route === 'checkout') assert.equal(store.issues[0].checkoutRunId, 'run-a');
        });
      }

      it('foreign-company issue with header absent or matching → 403 Forbidden, no mutation', async () => {
        for (const header of [undefined, 'run-a']) {
          for (const target of ['iss-d', 'iss-d-free']) {
            const before = snapshot();
            const res = await call(route, target, TOKEN_A(), header);
            assert.equal(res.status, 403);
            assert.notEqual(((await res.json()) as { code?: string }).code, 'run_id_mismatch');
            assert.equal(snapshot(), before);
          }
        }
      });

      it('chat token: header absent or equal to its chat session id is allowed; a run id header is a mismatch', async () => {
        const before = snapshot();
        const res = await call(route, 'iss-free', CHAT_A(), 'run-a');
        assert.equal(res.status, 403);
        assert.equal(snapshot(), before);
        const ok = await call(route, 'iss-free', CHAT_A(), 'chat-agent-a1');
        assert.ok(ok.status === 200 || ok.status === 201, `status ${ok.status}`);
        for (const a of store.activityLog) assert.equal((a.details as Row).runId, 'chat-agent-a1');
      });

      it('invalid token with a valid-looking header stays 401 (header is not a credential)', async () => {
        const before = snapshot();
        const forged = `pm_run_${b64(JSON.stringify({ runId: 'run-b', agentId: 'agent-a1', companyId: 'company-a', iat: 1 }))}`;
        assert.equal((await call(route, 'iss-b', forged, 'run-b')).status, 401);
        assert.equal(snapshot(), before);
      });
    });
  }

  it('checkout lock boundary unchanged: A (absent/matching header) on B- and C-held locks → 409; holder B → 200', async () => {
    for (const header of [undefined, 'run-a']) {
      for (const target of ['iss-b', 'iss-c']) {
        const before = snapshot();
        const res = await call('checkout', target, TOKEN_A(), header);
        assert.equal(res.status, 409);
        assert.equal(((await res.json()) as { code?: string }).code, 'lock_conflict');
        assert.equal(snapshot(), before);
      }
    }
    const holder = await call('checkout', 'iss-b', tokenFor('run-b', 'agent-a1', 'company-a'), 'run-b');
    assert.equal(holder.status, 200);
    assert.equal(store.issues[1].checkoutRunId, 'run-b');
  });

  it('PATCH with no header now records the authenticated run id (was null)', async () => {
    const res = await call('patch', 'iss-free', TOKEN_A());
    assert.equal(res.status, 200);
    assert.equal((store.activityLog[0].details as Row).runId, 'run-a');
  });
});
