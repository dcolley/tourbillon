/**
 * Approval routes: agent reads (REST list/detail, which back the agent listApprovals /
 * getApproval tools, and the create response), approval create, and the HITLy resume callback.
 * Real auth (signed agent run tokens) and real route code; db, wake/comment side effects and
 * the HITLy ingest client are replaced with small in-memory fakes.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { mintRunToken } from '@tourbillon/shared/agent-token';
import { hashResumeToken } from '../../lib/hitly/resume-token';

const AGENT_TOKEN_SECRET = 'test-agent-token-secret-approvals-0123456789abcdef';
const env = process.env as Record<string, string | undefined>;
const RESUME = 'resume-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij01';
const NESTED = 'nested-secret-value-zyxwvutsrqponmlk';
const HITLY_KEY = 'hitly-project-key-0123456789abcdef';

// ---- in-memory db ------------------------------------------------------------------------------
type Row = Record<string, any>;
type Col = { t: string; c: string; __col: true };
type Cond =
  | { op: 'eq' | 'gt' | 'gte'; col: Col; val: unknown }
  | { op: 'isNull'; col: Col }
  | { op: 'in'; col: Col; vals: unknown[] }
  | { op: 'and' | 'or'; xs: Cond[] }
  | { op: 'true' };
type Ctx = Record<string, Row | undefined>;
const store: Record<string, Row[]> = {};
let idSeq = 0;

function table(name: string) {
  return new Proxy({}, {
    get: (_t, prop: string | symbol) => {
      if (prop === '__table') return name;
      if (typeof prop !== 'string' || prop === '__col' || prop === 'then') return undefined;
      return { t: name, c: prop, __col: true } as Col;
    },
  });
}
const tables = Object.fromEntries(
  ['approvals', 'approvalResumeTokens', 'agents', 'companies', 'issues', 'activityLog', 'heartbeatRuns'].map((n) => [n, table(n)]),
);
const nameOf = (t: unknown) => (t as { __table: string }).__table;
const isCol = (v: unknown): v is Col => Boolean(v && typeof v === 'object' && (v as Col).__col);
const valOf = (ctx: Ctx, v: unknown) => (isCol(v) ? ctx[v.t]?.[v.c] : v);
function match(ctx: Ctx, cond?: Cond): boolean {
  if (!cond) return true;
  switch (cond.op) {
    case 'true': return true;
    case 'eq': return valOf(ctx, cond.col) === valOf(ctx, cond.val);
    case 'gt': return (valOf(ctx, cond.col) as Date) > (cond.val as Date);
    case 'gte': return (valOf(ctx, cond.col) as Date) >= (cond.val as Date);
    case 'isNull': return valOf(ctx, cond.col) == null;
    case 'in': return cond.vals.includes(valOf(ctx, cond.col));
    case 'and': return cond.xs.every((x) => match(ctx, x));
    case 'or': return cond.xs.some((x) => match(ctx, x));
  }
}
const rowsOf = (name: string) => (store[name] ??= []);
function project(ctx: Ctx, base: string, fields?: Record<string, unknown>): Row {
  if (!fields) return { ...ctx[base] };
  const out: Row = {};
  for (const [k, v] of Object.entries(fields)) {
    if (isCol(v)) out[k] = ctx[v.t]?.[v.c];
    else out[k] = ctx[nameOf(v)] ? { ...ctx[nameOf(v)] } : null; // whole table (join)
  }
  return out;
}
function selectBuilder(fields?: Record<string, unknown>) {
  let base = '';
  const joins: Array<{ t: string; on: Cond }> = [];
  let where: Cond | undefined;
  let limit = Infinity;
  const run = () => {
    const out: Row[] = [];
    for (const r of rowsOf(base)) {
      const ctx: Ctx = { [base]: r };
      for (const j of joins) ctx[j.t] = rowsOf(j.t).find((x) => match({ ...ctx, [j.t]: x }, j.on));
      if (match(ctx, where)) out.push(project(ctx, base, fields));
    }
    return out.slice(0, limit);
  };
  const b: any = {
    from: (t: unknown) => ((base = nameOf(t)), b),
    leftJoin: (t: unknown, on: Cond) => (joins.push({ t: nameOf(t), on }), b),
    where: (c: Cond) => ((where = c), b),
    orderBy: () => b,
    limit: (n: number) => ((limit = n), b),
    then: (res: (v: Row[]) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(run).then(res, rej),
  };
  return b;
}
const DEFAULTS: Record<string, () => Row> = {
  approvals: () => ({
    status: 'pending', issueIds: [], payload: {}, note: null, decidedAt: null, decidedByUserId: null,
    hitlyApprovalId: null, hitlyError: null, createdAt: new Date(), updatedAt: new Date(),
  }),
  approvalResumeTokens: () => ({ usedAt: null, createdAt: new Date() }),
};
function insertBuilder(t: unknown) {
  const name = nameOf(t);
  let inserted: Row[] = [];
  const b: any = {
    values: (v: Row | Row[]) => {
      inserted = (Array.isArray(v) ? v : [v]).map((x) => ({ id: `${name}-${++idSeq}`, ...(DEFAULTS[name]?.() ?? {}), ...x }));
      rowsOf(name).push(...inserted);
      return b;
    },
    returning: async () => inserted.map((r) => ({ ...r })),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(undefined).then(res, rej),
  };
  return b;
}
function updateBuilder(t: unknown) {
  const name = nameOf(t);
  let patch: Row = {};
  let where: Cond | undefined;
  const run = () => {
    const hit = rowsOf(name).filter((r) => match({ [name]: r }, where));
    hit.forEach((r) => Object.assign(r, patch));
    return hit.map((r) => ({ ...r }));
  };
  const b: any = {
    set: (v: Row) => ((patch = v), b),
    where: (c: Cond) => ((where = c), b),
    returning: async () => run(),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(run).then(() => undefined).then(res, rej),
  };
  return b;
}
function deleteBuilder(t: unknown) {
  const name = nameOf(t);
  return {
    where: async (c: Cond) => {
      store[name] = rowsOf(name).filter((r) => !match({ [name]: r }, c));
    },
  };
}
const queryApi = new Proxy({}, {
  get: (_t, name: string) => ({
    findFirst: async ({ where }: { where?: Cond } = {}) => {
      const r = rowsOf(name).find((x) => match({ [name]: x }, where));
      return r ? { ...r } : undefined;
    },
  }),
});
const ops = {
  select: (fields?: Record<string, unknown>) => selectBuilder(fields),
  insert: insertBuilder,
  update: updateBuilder,
  delete: deleteBuilder,
  query: queryApi,
};
const fakeDb = { ...ops, transaction: async <T>(fn: (tx: typeof ops) => Promise<T>) => fn(ops) };

// ---- side-effect fakes --------------------------------------------------------------------------
const ingested: Array<Record<string, any>> = [];
const wakes: unknown[] = [];

// ---- requests -----------------------------------------------------------------------------------
function runToken(agentId: string, companyId: string, runId: string) {
  return mintRunToken({ runId, agentId, companyId }, 3600);
}
function agentReq(url: string, token: string, init: { method?: string; body?: unknown } = {}) {
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
function resumeReq(approvalId: string, opts: { query?: string; header?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const qs = opts.query !== undefined ? `?token=${encodeURIComponent(opts.query)}` : '';
  return new NextRequest(`http://localhost/api/approvals/${approvalId}/hitly-resume${qs}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.header !== undefined ? { 'x-hitly-resume-token': opts.header } : {}),
      ...(opts.headers ?? {}),
    },
    body: JSON.stringify(opts.body ?? { decision: 'accept', metadata: {} }),
  });
}
const ctx = <T>(params: T) => ({ params: Promise.resolve(params) });

type Handler = (req: NextRequest, c: { params: Promise<any> }) => Promise<Response>;
const routes: Record<string, Record<string, Handler>> = {};

function seedTokenRow(approvalId: string, token: string, over: Row = {}) {
  rowsOf('approvalResumeTokens').push({
    approvalId,
    tokenHash: hashResumeToken(approvalId, token),
    expiresAt: new Date(Date.now() + 3600_000),
    usedAt: null,
    createdAt: new Date(),
    ...over,
  });
}
const approval = (id: string) => rowsOf('approvals').find((a) => a.id === id)!;

describe('approval routes', () => {
  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    const is = (id: string, name: string) => id === `@/lib/${name}` || id.endsWith(`/lib/${name}`);
    const col = (c: Col) => c;
    const mocks: Record<string, unknown> = {
      '@tourbillon/db': { db: fakeDb, ...tables },
      'drizzle-orm': {
        eq: (c: Col, val: unknown) => ({ op: 'eq', col: col(c), val }),
        gt: (c: Col, val: unknown) => ({ op: 'gt', col: col(c), val }),
        gte: (c: Col, val: unknown) => ({ op: 'gte', col: col(c), val }),
        isNull: (c: Col) => ({ op: 'isNull', col: col(c) }),
        inArray: (c: Col, vals: unknown[]) => ({ op: 'in', col: col(c), vals }),
        and: (...xs: Cond[]) => ({ op: 'and', xs: xs.filter(Boolean) }),
        or: (...xs: Cond[]) => ({ op: 'or', xs: xs.filter(Boolean) }),
        ilike: () => ({ op: 'true' }),
        sql: () => ({}),
        desc: (c: unknown) => c,
        asc: (c: unknown) => c,
      },
    };
    Module.prototype.require = function (id: string) {
      if (id in mocks) return mocks[id];
      if (is(id, 'wake-client')) return { enqueueApprovalWake: async (w: unknown) => void wakes.push(w) };
      if (is(id, 'issue-comments')) return { addIssueComment: async () => {} };
      if (is(id, 'hitly/client')) {
        return {
          ingestHitlyApproval: async (_gate: unknown, payload: Record<string, any>) => {
            ingested.push(payload);
            return 'hitly-item-1';
          },
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    routes.list = await import('./companies/[companyId]/approvals/route');
    routes.detail = await import('./companies/[companyId]/approvals/[approvalId]/route');
    routes.resume = await import('./approvals/[approvalId]/hitly-resume/route');
  });

  beforeEach(() => {
    env.TOURBILLON_AGENT_TOKEN_SECRET = AGENT_TOKEN_SECRET;
    for (const k of Object.keys(store)) delete store[k];
    ingested.length = 0;
    wakes.length = 0;
    store.companies = [
      {
        id: 'co-a',
        settings: {
          hitlyGate: { enabled: true, baseUrl: 'https://hitly.example', resumeHost: 'https://tb.example', projectId: 'prj_1', apiKey: HITLY_KEY },
        },
      },
      { id: 'co-b', settings: {} },
    ];
    store.agents = [
      { id: 'agent-a', companyId: 'co-a', name: 'A', urlKey: 'a', status: 'active' },
      { id: 'agent-a2', companyId: 'co-a', name: 'A2', urlKey: 'a2', status: 'active' },
      { id: 'agent-b', companyId: 'co-b', name: 'B', urlKey: 'b', status: 'active' },
    ];
    store.heartbeatRuns = [
      { id: 'run-a', agentId: 'agent-a', companyId: 'co-a', status: 'running' },
      { id: 'run-a2', agentId: 'agent-a2', companyId: 'co-a', status: 'running' },
      { id: 'run-b', agentId: 'agent-b', companyId: 'co-b', status: 'running' },
    ];
    store.issues = [{ id: 'iss-1', companyId: 'co-a', identifier: 'A-1', title: 'Issue', status: 'blocked', boardApprovalId: 'appr-legacy' }];
    store.activityLog = [];
    store.approvals = [
      {
        id: 'appr-legacy', companyId: 'co-a', type: 'hire_agent', status: 'pending', requestedByAgentId: 'agent-a2',
        issueIds: ['iss-1'], note: `n ${RESUME}`, decidedAt: null, decidedByUserId: null, hitlyApprovalId: 'hitly-item-0',
        hitlyError: `HITLy ingest HTTP 400: https://tb.example/api/approvals/appr-legacy/hitly-resume?token=${RESUME}`,
        payload: {
          title: 'Hire', summary: 's', hitlyResumeToken: RESUME, priorStatuses: { 'iss-1': 'todo' },
          args: { deep: [{ config: { apiKey: NESTED, 'x-api-key': NESTED, resumeToken: RESUME } }] },
        },
        createdAt: new Date(), updatedAt: new Date(),
      },
    ];
  });

  const tokenA = () => runToken('agent-a', 'co-a', 'run-a');
  const tokenB = () => runToken('agent-b', 'co-b', 'run-b');

  async function createGated(token = tokenA(), body: Record<string, unknown> = {}) {
    const res = await routes.list.POST(
      agentReq('/api/companies/co-a/approvals', token, {
        method: 'POST',
        body: { type: 'hire_agent', payload: { title: 'Gated', summary: 'needs a human' }, ...body },
      }),
      ctx({ companyId: 'co-a' }),
    );
    return res;
  }
  /** Resume token HITLy received in the resumeUrl at ingest. */
  const issuedToken = () => new URL(ingested.at(-1)!.resumeUrl).searchParams.get('token')!;

  // ------------------------------------------------------------------------------ agent reads
  describe('agent reads never include resume credentials', () => {
    const assertClean = (json: string) => {
      assert.ok(!json.includes(RESUME), 'resume token absent');
      assert.ok(!json.includes(NESTED), 'nested credential absent');
      assert.ok(!json.includes('hitlyResumeToken'), 'reserved key absent');
      assert.ok(!json.includes('tokenHash'), 'digest column absent');
    };

    it('list (another agent in the same company)', async () => {
      const res = await routes.list.GET(agentReq('/api/companies/co-a/approvals', tokenA()), ctx({ companyId: 'co-a' }));
      assert.equal(res.status, 200);
      const text = await res.text();
      assertClean(text);
      const body = JSON.parse(text);
      assert.equal(body.approvals[0].payload.title, 'Hire');
    });

    it('detail (another agent in the same company)', async () => {
      const res = await routes.detail.GET(
        agentReq('/api/companies/co-a/approvals/appr-legacy', tokenA()),
        ctx({ companyId: 'co-a', approvalId: 'appr-legacy' }),
      );
      assert.equal(res.status, 200);
      const text = await res.text();
      assertClean(text);
      assert.equal(JSON.parse(text).approval.payload.summary, 's');
    });

    it('create response and later reads of a HITLy-gated approval', async () => {
      const res = await createGated();
      assert.equal(res.status, 201);
      const created = await res.json();
      const token = issuedToken();
      const list = await (await routes.list.GET(agentReq('/api/companies/co-a/approvals', tokenA()), ctx({ companyId: 'co-a' }))).text();
      const detail = await (
        await routes.detail.GET(agentReq(`/api/companies/co-a/approvals/${created.id}`, tokenA()), ctx({ companyId: 'co-a', approvalId: created.id }))
      ).text();
      for (const json of [JSON.stringify(created), list, detail]) {
        assert.ok(!json.includes(token));
        assert.ok(!json.includes(HITLY_KEY));
        assert.ok(!json.includes('tokenHash'));
      }
    });

    it('other companies are still refused', async () => {
      const res = await routes.list.GET(agentReq('/api/companies/co-a/approvals', tokenB()), ctx({ companyId: 'co-a' }));
      assert.equal(res.status, 403);
    });
  });

  // ------------------------------------------------------------------------------ storage
  describe('resume credential storage', () => {
    it('stores only a digest, outside the approval payload', async () => {
      const created = await (await createGated()).json();
      const token = issuedToken();
      const row = approval(created.id);
      assert.ok(!JSON.stringify(row).includes(token));
      const stored = rowsOf('approvalResumeTokens').find((r) => r.approvalId === created.id)!;
      assert.equal(stored.tokenHash, hashResumeToken(created.id, token));
      assert.ok(stored.expiresAt > new Date());
      assert.equal(stored.usedAt, null);
    });

    it('a payload cannot plant the reserved key', async () => {
      const created = await (await createGated(tokenA(), { payload: { title: 'x', hitlyResumeToken: 'planted-value-123456' } })).json();
      assert.ok(!('hitlyResumeToken' in (approval(created.id).payload as object)));
    });

    it('a failed ingest leaves no usable credential', async () => {
      const original = ingested.push;
      ingested.push = () => {
        throw new Error('HITLy ingest HTTP 500: boom');
      };
      try {
        const res = await createGated();
        assert.equal(res.status, 201);
        const created = await res.json();
        assert.match(created.hitlyError, /HITLy ingest HTTP 500/);
        assert.equal(rowsOf('approvalResumeTokens').filter((r) => r.approvalId === created.id).length, 0);
      } finally {
        ingested.push = original;
      }
    });
  });

  // ------------------------------------------------------------------------------ requester
  describe('requester identity on create', () => {
    it('defaults to the calling agent', async () => {
      const created = await (await createGated()).json();
      assert.equal(approval(created.id).requestedByAgentId, 'agent-a');
    });
    it('accepts the calling agent id in the body', async () => {
      const res = await createGated(tokenA(), { requestedByAgentId: 'agent-a' });
      assert.equal(res.status, 201);
    });
    it('refuses a different agent in the same company', async () => {
      const before = rowsOf('approvals').length;
      const res = await createGated(tokenA(), { requestedByAgentId: 'agent-a2' });
      assert.equal(res.status, 403);
      assert.equal(rowsOf('approvals').length, before);
    });
    it('refuses an agent from another company', async () => {
      const before = rowsOf('approvals').length;
      const res = await createGated(tokenA(), { requestedByAgentId: 'agent-b' });
      assert.equal(res.status, 403);
      assert.equal(rowsOf('approvals').length, before);
    });
    it("refuses a token for another company's URL", async () => {
      const res = await createGated(tokenB());
      assert.equal(res.status, 403);
    });
  });

  // ------------------------------------------------------------------------------ resume
  describe('HITLy resume callback', () => {
    async function gated() {
      const created = await (await createGated()).json();
      return { id: created.id as string, token: issuedToken() };
    }

    it('applies the decision for the genuine callback (query form)', async () => {
      const { id, token } = await gated();
      const res = await routes.resume.POST(resumeReq(id, { query: token, body: { decision: 'accept', id: 'hitly-item-1', metadata: {} } }), ctx({ approvalId: id }));
      assert.equal(res.status, 200);
      assert.equal(approval(id).status, 'approved');
      assert.equal(approval(id).decidedByUserId, 'hitly');
      assert.ok(rowsOf('approvalResumeTokens').find((r) => r.approvalId === id)!.usedAt instanceof Date);
      assert.equal(wakes.length, 1);
    });

    it('applies a reject via the header form', async () => {
      const { id, token } = await gated();
      const res = await routes.resume.POST(resumeReq(id, { header: token, body: { decision: 'reject', metadata: { note: 'no' } } }), ctx({ approvalId: id }));
      assert.equal(res.status, 200);
      assert.equal(approval(id).status, 'rejected');
    });

    for (const decision of ['accept', 'reject']) {
      it(`refuses an agent run token (${decision})`, async () => {
        const { id, token } = await gated();
        const res = await routes.resume.POST(
          resumeReq(id, { query: token, headers: { authorization: `Bearer ${tokenA()}` }, body: { decision, metadata: {} } }),
          ctx({ approvalId: id }),
        );
        assert.equal(res.status, 403);
        assert.equal(approval(id).status, 'pending');
      });
      it(`refuses a company token (${decision})`, async () => {
        const { id, token } = await gated();
        const res = await routes.resume.POST(
          resumeReq(id, { query: token, headers: { 'x-company-token': 'eyJhbGciOiJIUzI1NiJ9.e30.sig' }, body: { decision, metadata: {} } }),
          ctx({ approvalId: id }),
        );
        assert.equal(res.status, 403);
        assert.equal(approval(id).status, 'pending');
      });
    }

    it('refuses an agent run token with no resume token', async () => {
      const { id } = await gated();
      const res = await routes.resume.POST(resumeReq(id, { headers: { authorization: `Bearer ${tokenA()}` } }), ctx({ approvalId: id }));
      assert.equal(res.status, 403);
      assert.equal(approval(id).status, 'pending');
    });

    it('refuses a wrong token', async () => {
      const { id } = await gated();
      const res = await routes.resume.POST(resumeReq(id, { query: 'not-the-token' }), ctx({ approvalId: id }));
      assert.equal(res.status, 401);
      assert.equal(approval(id).status, 'pending');
    });

    it("refuses another approval's token", async () => {
      const first = await gated();
      const second = await gated();
      const res = await routes.resume.POST(resumeReq(second.id, { query: first.token }), ctx({ approvalId: second.id }));
      assert.equal(res.status, 401);
      assert.equal(approval(second.id).status, 'pending');
    });

    it('refuses a reused token', async () => {
      const { id, token } = await gated();
      assert.equal((await routes.resume.POST(resumeReq(id, { query: token }), ctx({ approvalId: id }))).status, 200);
      approval(id).status = 'pending'; // even if the approval were pending again
      const res = await routes.resume.POST(resumeReq(id, { query: token, body: { decision: 'reject', metadata: {} } }), ctx({ approvalId: id }));
      assert.equal(res.status, 409);
      assert.equal(approval(id).status, 'pending');
    });

    it('a token consumed concurrently cannot decide twice', async () => {
      const { id, token } = await gated();
      const [a, b] = await Promise.all([
        routes.resume.POST(resumeReq(id, { query: token }), ctx({ approvalId: id })),
        routes.resume.POST(resumeReq(id, { query: token, body: { decision: 'reject', metadata: {} } }), ctx({ approvalId: id })),
      ]);
      assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    });

    it('refuses an expired token', async () => {
      const { id, token } = await gated();
      rowsOf('approvalResumeTokens').find((r) => r.approvalId === id)!.expiresAt = new Date(Date.now() - 1000);
      const res = await routes.resume.POST(resumeReq(id, { query: token }), ctx({ approvalId: id }));
      assert.equal(res.status, 410);
      assert.equal(approval(id).status, 'pending');
    });

    it('does not honour a plaintext token stored by earlier versions', async () => {
      const res = await routes.resume.POST(resumeReq('appr-legacy', { query: RESUME }), ctx({ approvalId: 'appr-legacy' }));
      assert.equal(res.status, 410);
      assert.equal(approval('appr-legacy').status, 'pending');
    });

    it('a stored digest is not itself accepted as the token', async () => {
      const { id } = await gated();
      const digest = rowsOf('approvalResumeTokens').find((r) => r.approvalId === id)!.tokenHash;
      const res = await routes.resume.POST(resumeReq(id, { query: digest }), ctx({ approvalId: id }));
      assert.equal(res.status, 401);
    });

    it('refuses a header that disagrees with the query', async () => {
      const { id, token } = await gated();
      const res = await routes.resume.POST(resumeReq(id, { query: token, header: 'other' }), ctx({ approvalId: id }));
      assert.equal(res.status, 400);
      assert.equal(approval(id).status, 'pending');
    });

    it('requires a token', async () => {
      const { id } = await gated();
      const res = await routes.resume.POST(resumeReq(id), ctx({ approvalId: id }));
      assert.equal(res.status, 401);
    });

    it('an approval already decided in Tourbillon stays as decided', async () => {
      const { id, token } = await gated();
      approval(id).status = 'rejected';
      const res = await routes.resume.POST(resumeReq(id, { query: token }), ctx({ approvalId: id }));
      assert.equal(res.status, 200);
      assert.equal((await res.json()).alreadyDecided, true);
      assert.equal(approval(id).status, 'rejected');
    });

    it('activity rows written on resume never carry the token', async () => {
      rowsOf('issues').push({ id: 'iss-3', companyId: 'co-a', identifier: 'A-3', title: 'I3', status: 'todo', boardApprovalId: null });
      const res = await createGated(tokenA(), { issueIds: ['iss-3'] });
      assert.equal(res.status, 201);
      const { id } = await res.json();
      const token = issuedToken();
      assert.equal((await routes.resume.POST(resumeReq(id, { query: token }), ctx({ approvalId: id }))).status, 200);
      assert.ok(rowsOf('activityLog').length > 0);
      assert.ok(!JSON.stringify(rowsOf('activityLog')).includes(token));
      assert.equal(rowsOf('issues').find((i) => i.id === 'iss-3')!.status, 'todo');
    });
  });
});
