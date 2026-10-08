/**
 * PM decision on #130: every approval create/decide path writes exactly one `approval.created`
 * / `approval.decided` activity_log row with the path's actor and the note; a repeat or racing
 * decide writes no second row; rows carry the approval's company; the details history uses them.
 *
 * Routes run for real against a small in-memory db; auth, wake and comment modules are stubbed.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

type Row = Record<string, unknown>;
type Cond =
  | { op: 'eq'; c: string; val: unknown }
  | { op: 'and'; xs: Array<Cond | undefined> }
  | { op: 'or'; xs: Array<Cond | undefined> }
  | { op: 'in'; c: string; vals: unknown[] }
  | { op: 'true' };

const store: Record<string, Row[]> = {};
let seq = 0;
let clock = Date.UTC(2026, 9, 8, 9, 0);
/** When set, findFirst returns a stale pending copy (simulates a decide racing another one). */
let stalePending = false;

function table(name: string) {
  return new Proxy({ __table: name } as Record<string, unknown>, {
    get: (t, prop: string) => (prop === '__table' ? name : { c: prop }),
  });
}
const nameOf = (t: unknown) => (t as { __table: string }).__table;
function match(row: Row, cond?: Cond): boolean {
  if (!cond) return true;
  switch (cond.op) {
    case 'eq':
      return row[cond.c] === cond.val;
    case 'in':
      return cond.vals.includes(row[cond.c]);
    case 'and':
      return cond.xs.every((x) => match(row, x));
    case 'or':
      return cond.xs.some((x) => x && match(row, x));
    default:
      return true;
  }
}
const TABLES = ['approvals', 'agents', 'companies', 'issues', 'activityLog'];
const tables = Object.fromEntries(TABLES.map((n) => [n, table(n)]));

function builder(kind: 'select' | 'insert' | 'update', t?: unknown) {
  const st: { table?: unknown; where?: Cond; set?: Row; values?: Row | Row[] } = { table: t };
  const exec = () => {
    const name = nameOf(st.table);
    const rows = (store[name] ??= []);
    if (kind === 'select') return rows.filter((r) => match(r, st.where));
    if (kind === 'insert') {
      const vs = Array.isArray(st.values) ? st.values : [st.values ?? {}];
      const inserted = vs.map((v) => ({ id: `${name}-${++seq}`, createdAt: new Date((clock += 60_000)), ...v }));
      rows.push(...inserted);
      return inserted;
    }
    const hit = rows.filter((r) => match(r, st.where));
    hit.forEach((r) => Object.assign(r, st.set));
    return hit;
  };
  const chain: Record<string, unknown> = {
    from: (x: unknown) => ((st.table = x), chain),
    set: (v: Row) => ((st.set = v), chain),
    values: (v: Row | Row[]) => ((st.values = v), chain),
    where: (c: Cond) => ((st.where = c), chain),
    limit: () => chain,
    orderBy: () => chain,
    returning: () => chain,
    then: (res: (v: unknown) => void, rej: (e: unknown) => void) => {
      try {
        res(exec());
      } catch (e) {
        rej(e);
      }
    },
  };
  return chain;
}
const dbApi = {
  select: () => builder('select'),
  insert: (t: unknown) => builder('insert', t),
  update: (t: unknown) => builder('update', t),
};
const fakeDb = {
  ...dbApi,
  query: new Proxy({}, {
    get: (_t, name: string) => ({
      findFirst: async ({ where }: { where?: Cond } = {}) => {
        const row = (store[name] ?? []).find((r) => match(r, where));
        return row && stalePending && name === 'approvals' ? { ...row, status: 'pending' } : row;
      },
    }),
  }),
  transaction: async <T>(fn: (tx: typeof dbApi) => Promise<T>) => fn(dbApi),
};
const fakeDrizzle = {
  eq: (col: { c: string }, val: unknown) => ({ op: 'eq', c: col.c, val }),
  and: (...xs: Cond[]) => ({ op: 'and', xs }),
  or: (...xs: Cond[]) => ({ op: 'or', xs }),
  inArray: (col: { c: string }, vals: unknown[]) => ({ op: 'in', c: col.c, vals }),
  ne: () => ({ op: 'true' }),
  gte: () => ({ op: 'true' }),
  ilike: () => ({ op: 'true' }),
  sql: () => ({ op: 'true' }),
  desc: (c: unknown) => c,
  asc: (c: unknown) => c,
};
const asyncStub = () => new Proxy({}, { get: (_t, k) => (k === '__esModule' ? true : async () => null) });

type Handler = (req: NextRequest, c: { params: Promise<any> }) => Promise<Response>;
const routes: Record<string, Handler> = {};
let mcpPOST: (req: NextRequest) => Promise<Response>;
let detail: typeof import('../../lib/approval-detail');

const ctx = <T>(params: T) => ({ params: Promise.resolve(params) });
const json = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const lifecycle = (action: string) =>
  (store.activityLog ?? []).filter((r) => r.entityType === 'approval' && r.action === action);

function seed() {
  seq = 0;
  stalePending = false;
  store.companies = [
    { id: 'company-a', settings: {} },
    { id: 'company-b', settings: {} },
  ];
  store.agents = [
    { id: 'agent-a', companyId: 'company-a', name: 'Alice', urlKey: 'alice', runtimeConfig: {} },
    { id: 'agent-b', companyId: 'company-b', name: 'Bob', urlKey: 'bob', runtimeConfig: {} },
  ];
  store.issues = [
    { id: 'issue-a1', companyId: 'company-a', identifier: 'TOUR-1', title: 'A', status: 'in_progress', boardApprovalId: null },
  ];
  store.approvals = [];
  store.activityLog = [];
}
function pending(id: string, companyId: string, extra: Row = {}) {
  const row = {
    id, companyId, type: 'request_board_approval', status: 'pending', requestedByAgentId: companyId === 'company-a' ? 'agent-a' : 'agent-b',
    decidedByUserId: null, issueIds: [], payload: { title: 'T' }, note: null, decidedAt: null,
    hitlyApprovalId: null, hitlyError: null, createdAt: new Date(clock), updatedAt: new Date(clock), ...extra,
  };
  store.approvals.push(row);
  return row;
}

describe('approval.created / approval.decided activity rows (every path)', () => {
  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    const REAL_LIB = new Set(['approval-activity', 'approval-detail', 'approval-links']);
    Module.prototype.require = function (id: string) {
      if (id === '@tourbillon/db') return { db: fakeDb, ...tables };
      if (id === 'drizzle-orm') return fakeDrizzle;
      if (id === '@/lib/auth/agent-token-auth') {
        // Bearer agent:<agentId>:<companyId>
        return {
          authenticateAgentToken: async (t: string) => {
            const [kind, agentId, companyId] = String(t).split(':');
            return kind === 'agent' ? { agentId, companyId, runId: 'run-1' } : null;
          },
        };
      }
      if (id === '@/lib/board-route-auth') {
        return {
          requireBoardCompany: async (req: NextRequest) => {
            const c = req.headers.get('x-test-board-company');
            return c
              ? { ok: true, value: { id: c } }
              : { ok: false, response: Response.json({ error: 'Unauthorized' }, { status: 401 }) };
          },
        };
      }
      if (id === '@/lib/mobile-auth') {
        return { verifyMobileToken: async (req: NextRequest) => req.headers.get('x-test-board-company') };
      }
      const m = /^@\/lib\/(.+)$/.exec(id);
      if (m && !REAL_LIB.has(m[1])) return asyncStub();
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    routes.create = (await import('./companies/[companyId]/approvals/route')).POST as Handler;
    routes.decide = (await import('./approvals/[approvalId]/decide/route')).POST as Handler;
    routes.hitly = (await import('./approvals/[approvalId]/hitly-resume/route')).POST as Handler;
    mcpPOST = (await import('./mcp/route')).POST as never;
    detail = await import('../../lib/approval-detail');
  });
  beforeEach(seed);

  const create = (companyId: string, agentId: string, body: Row) =>
    routes.create(json(`/api/companies/${companyId}/approvals`, body, { authorization: `Bearer agent:${agentId}:${companyId}` }), ctx({ companyId }));
  const decide = (company: string, approvalId: string, decision: string, note?: string) =>
    routes.decide(json(`/api/approvals/${approvalId}/decide`, { decision, note }, { 'x-test-board-company': company }), ctx({ approvalId }));
  const hitly = (approvalId: string, token: string, decision: string, note?: string) =>
    routes.hitly(json(`/api/approvals/${approvalId}/hitly-resume?token=${token}`, { decision, id: 'hitly-1', metadata: note ? { note } : {} }), ctx({ approvalId }));
  const mcp = async (company: string, args: Row) => {
    const res = await mcpPOST(
      json('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'decide_approval', arguments: args } }, { 'x-test-board-company': company }),
    );
    return (await res.json()) as { result?: unknown; error?: { message: string } };
  };

  describe('agent-created approvals: POST /api/companies/:id/approvals', () => {
    it('writes exactly one approval.created row: agent actor (id + name), summary as the note, own company', async () => {
      const res = await create('company-a', 'agent-a', {
        type: 'request_board_approval', issueIds: ['issue-a1'], payload: { title: 'Ship', summary: 'Please ship v2' },
      });
      assert.equal(res.status, 201);
      const approval = (await res.json()) as { id: string };
      const rows = lifecycle('approval.created');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].entityId, approval.id);
      assert.equal(rows[0].companyId, 'company-a');
      assert.deepEqual([rows[0].actorType, rows[0].actorId, rows[0].actorName], ['agent', 'agent-a', 'Alice']);
      assert.equal((rows[0].details as Row).note, 'Please ship v2');
      assert.equal(lifecycle('approval.decided').length, 0);
    });

    it('no summary → note null; unknown agent name → actorName null (actorId kept)', async () => {
      store.agents = [];
      assert.equal((await create('company-a', 'agent-a', { type: 'hire_agent', payload: { title: 'x' } })).status, 201);
      const [row] = lifecycle('approval.created');
      assert.equal((row.details as Row).note, null);
      assert.equal(row.actorName, null);
      assert.equal(row.actorId, 'agent-a');
    });
  });

  describe('board decide (UI form + JSON API): POST /api/approvals/:id/decide', () => {
    it('writes exactly one approval.decided row with the Board actor and the decision note', async () => {
      pending('appr-a', 'company-a');
      assert.equal((await decide('company-a', 'appr-a', 'approved', 'Looks good')).status, 200);
      const rows = lifecycle('approval.decided');
      assert.equal(rows.length, 1);
      assert.deepEqual([rows[0].actorType, rows[0].actorId, rows[0].actorName], ['user', 'board', 'Board']);
      assert.equal(rows[0].companyId, 'company-a');
      assert.deepEqual([(rows[0].details as Row).decision, (rows[0].details as Row).note], ['approved', 'Looks good']);
    });

    it('a second decide on an already-decided approval → 409, no second row', async () => {
      pending('appr-a', 'company-a');
      await decide('company-a', 'appr-a', 'approved');
      assert.equal((await decide('company-a', 'appr-a', 'rejected', 'late')).status, 409);
      assert.equal(lifecycle('approval.decided').length, 1);
      assert.equal((lifecycle('approval.decided')[0].details as Row).note, null);
    });

    it('a decide racing another (stale pending read) → 409, no row, approval unchanged', async () => {
      pending('appr-a', 'company-a', { status: 'approved', decidedAt: new Date(clock) });
      stalePending = true;
      assert.equal((await decide('company-a', 'appr-a', 'rejected', 'needs work')).status, 409);
      assert.equal(lifecycle('approval.decided').length, 0);
      assert.equal(store.approvals[0].status, 'approved');
    });

    it("another company's approval → 404, no row anywhere", async () => {
      pending('appr-b', 'company-b');
      assert.equal((await decide('company-a', 'appr-b', 'approved')).status, 404);
      assert.equal(store.activityLog.length, 0);
      assert.equal(store.approvals[0].status, 'pending');
    });
  });

  describe('reject requires a reason (board UI + board API)', () => {
    for (const note of [undefined, '', '   \n ']) {
      it(`JSON reject with reason ${JSON.stringify(note)} → 400, approval still pending, no row`, async () => {
        pending('appr-a', 'company-a');
        const res = await decide('company-a', 'appr-a', 'rejected', note);
        assert.equal(res.status, 400);
        assert.match(((await res.json()) as { error: string }).error, /reason is required/);
        assert.equal(store.approvals[0].status, 'pending');
        assert.equal(store.activityLog.length, 0);
      });
    }

    it('HTML form reject without a reason → 303 back to the details page with error=reason_required', async () => {
      pending('appr-a', 'company-a');
      const req = new NextRequest('http://localhost/api/approvals/appr-a/decide', {
        method: 'POST',
        headers: { accept: 'text/html', 'x-test-board-company': 'company-a', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ decision: 'rejected', note: '  ' }).toString(),
      });
      const res = await routes.decide(req, ctx({ approvalId: 'appr-a' }));
      assert.equal(res.status, 303);
      const loc = new URL(res.headers.get('location') ?? '');
      assert.equal(loc.pathname, '/approval/appr-a');
      assert.equal(loc.searchParams.get('error'), 'reason_required');
      assert.equal(store.approvals[0].status, 'pending');
    });

    it('reject with a reason → 200 and the reason is the decided row note; approve still needs none', async () => {
      pending('appr-a', 'company-a');
      pending('appr-c', 'company-a');
      assert.equal((await decide('company-a', 'appr-a', 'rejected', 'Split the migration')).status, 200);
      assert.equal((await decide('company-a', 'appr-c', 'approved')).status, 200);
      const notes = lifecycle('approval.decided').map((r) => [r.entityId, (r.details as Row).note]);
      assert.deepEqual(notes, [['appr-a', 'Split the migration'], ['appr-c', null]]);
    });

    it('MCP decide_approval: reject without a reason (missing, empty, blank, non-string) → tool error, nothing changes', async () => {
      pending('appr-a', 'company-a', { issueIds: ['issue-a1'] });
      store.issues[0].boardApprovalId = 'appr-a';
      store.issues[0].status = 'blocked';
      for (const reason of [undefined, '', '   \n\t', 42]) {
        const r = await mcp('company-a', { company_id: 'company-a', approval_id: 'appr-a', decision: 'rejected', reason });
        assert.equal(r.result, undefined, JSON.stringify(r));
        assert.match(r.error?.message ?? '', /reason is required to reject/);
      }
      assert.deepEqual([store.approvals[0].status, store.approvals[0].note, store.approvals[0].decidedAt], ['pending', null, null]);
      assert.deepEqual([store.issues[0].status, store.issues[0].boardApprovalId], ['blocked', 'appr-a']);
      assert.equal(store.activityLog.length, 0);
    });

    it('MCP decide_approval: reject with a reason → rejected, reason stored and on the decided row; approve needs none', async () => {
      pending('appr-a', 'company-a');
      pending('appr-c', 'company-a');
      const r = await mcp('company-a', { company_id: 'company-a', approval_id: 'appr-a', decision: 'rejected', reason: 'Split the migration' });
      assert.equal(r.error, undefined, JSON.stringify(r));
      const ok = await mcp('company-a', { company_id: 'company-a', approval_id: 'appr-c', decision: 'approved' });
      assert.equal(ok.error, undefined, JSON.stringify(ok));
      assert.deepEqual(
        store.approvals.map((a) => [a.id, a.status, a.note ?? null]),
        [['appr-a', 'rejected', 'Split the migration'], ['appr-c', 'approved', null]],
      );
      const notes = lifecycle('approval.decided').map((x) => [x.entityId, (x.details as Row).note]);
      assert.deepEqual(notes, [['appr-a', 'Split the migration'], ['appr-c', null]]);
    });
  });

  describe('HITLy resume: POST /api/approvals/:id/hitly-resume', () => {
    it('writes exactly one approval.decided row with the HITLy actor and note; a repeat writes none', async () => {
      pending('appr-a', 'company-a', { hitlyApprovalId: 'hitly-1', payload: { title: 'T', hitlyResumeToken: 'tok-123456789' } });
      assert.equal((await hitly('appr-a', 'tok-123456789', 'accept', 'ok by ops')).status, 200);
      const again = await hitly('appr-a', 'tok-123456789', 'reject');
      assert.deepEqual(await again.json(), { status: 'ok', alreadyDecided: true });
      const rows = lifecycle('approval.decided');
      assert.equal(rows.length, 1);
      assert.deepEqual([rows[0].actorType, rows[0].actorId, rows[0].actorName], ['system', 'hitly', 'HITLy']);
      assert.deepEqual([(rows[0].details as Row).decision, (rows[0].details as Row).note], ['approved', 'ok by ops']);
      assert.equal(rows[0].companyId, 'company-a');
    });

    it('activity rows never store the resume token or a secret echoed in the note (HITLy, board, MCP)', async () => {
      const TOKEN = 'dummy-resume-token-abcdef123456';
      const payload = { title: 'T', hitlyResumeToken: TOKEN, priorStatuses: { 'issue-a1': 'in_progress' } };
      const halt = (id: string) => {
        store.issues[0].boardApprovalId = id;
        store.issues[0].status = 'blocked';
      };
      pending('appr-h', 'company-a', { hitlyApprovalId: 'hitly-1', issueIds: ['issue-a1'], payload });
      halt('appr-h');
      assert.equal((await hitly('appr-h', TOKEN, 'reject', `bad; resume ${TOKEN}; Bearer dummybearer0123456789`)).status, 200);
      pending('appr-b', 'company-a', { issueIds: ['issue-a1'], payload });
      halt('appr-b');
      assert.equal((await decide('company-a', 'appr-b', 'rejected', `token=${TOKEN} apiKey=dummyinlinekey0123`)).status, 200);
      pending('appr-m', 'company-a', { issueIds: ['issue-a1'], payload });
      halt('appr-m');
      const m = await mcp('company-a', { company_id: 'company-a', approval_id: 'appr-m', decision: 'rejected', reason: `see ${TOKEN}` });
      assert.equal(m.error, undefined, JSON.stringify(m));

      const stored = JSON.stringify(store.activityLog);
      for (const leak of [TOKEN, 'dummybearer0123456789', 'dummyinlinekey0123']) assert.ok(!stored.includes(leak), leak);
      const notes = Object.fromEntries(lifecycle('approval.decided').map((r) => [r.entityId, (r.details as Row).note]));
      assert.deepEqual(notes, {
        'appr-h': 'bad; resume [redacted]; Bearer [redacted]',
        'appr-b': 'token=[redacted] apiKey=[redacted]',
        'appr-m': 'see [redacted]',
      });
      // The issue.updated rows the HITLy and board decides write carry the same scrubbed note.
      const issueNotes = store.activityLog
        .filter((r) => r.action === 'issue.updated' && r.entityType === 'issue')
        .map((r) => [(r.details as Row).approvalId, (r.details as Row).note]);
      assert.deepEqual(issueNotes, [
        ['appr-h', 'bad; resume [redacted]; Bearer [redacted]'],
        ['appr-b', 'token=[redacted] apiKey=[redacted]'],
      ]);
    });

    it('racing decide (stale pending read) → idempotent ok, no row', async () => {
      pending('appr-a', 'company-a', { status: 'rejected', payload: { hitlyResumeToken: 'tok-123456789' } });
      stalePending = true;
      const res = await hitly('appr-a', 'tok-123456789', 'accept');
      assert.deepEqual(await res.json(), { status: 'ok', alreadyDecided: true });
      assert.equal(lifecycle('approval.decided').length, 0);
    });
  });

  describe('MCP decide_approval', () => {
    it('writes exactly one approval.decided row with the MCP actor and reason; a repeat errors, no second row', async () => {
      pending('appr-a', 'company-a');
      const first = await mcp('company-a', { company_id: 'company-a', approval_id: 'appr-a', decision: 'rejected', reason: 'Too costly' });
      assert.equal(first.error, undefined, JSON.stringify(first));
      const second = await mcp('company-a', { company_id: 'company-a', approval_id: 'appr-a', decision: 'approved' });
      assert.match(second.error?.message ?? '', /already decided/);
      const rows = lifecycle('approval.decided');
      assert.equal(rows.length, 1);
      assert.deepEqual([rows[0].actorType, rows[0].actorId, rows[0].actorName], ['user', 'mcp', 'Board (via MCP)']);
      assert.deepEqual([(rows[0].details as Row).decision, (rows[0].details as Row).note], ['rejected', 'Too costly']);
    });

    it("another company's approval → not found, no row", async () => {
      pending('appr-b', 'company-b');
      const r = await mcp('company-a', { company_id: 'company-a', approval_id: 'appr-b', decision: 'approved' });
      assert.match(r.error?.message ?? '', /not found/i);
      assert.equal(store.activityLog.length, 0);
    });

    it('racing decide (stale pending read) → already decided, no row', async () => {
      pending('appr-a', 'company-a', { status: 'approved' });
      stalePending = true;
      const r = await mcp('company-a', { company_id: 'company-a', approval_id: 'appr-a', decision: 'rejected', reason: 'Too late' });
      assert.match(r.error?.message ?? '', /already decided/);
      assert.equal(lifecycle('approval.decided').length, 0);
    });
  });

  describe('details history from the new rows', () => {
    it('create → decide via the routes: one created, one decided, chronological, actors and notes from the rows', async () => {
      const res = await create('company-a', 'agent-a', {
        type: 'request_board_approval', issueIds: ['issue-a1'], payload: { title: 'Ship', summary: 'Please ship v2' },
      });
      const { id } = (await res.json()) as { id: string };
      assert.equal((await decide('company-a', id, 'approved', 'Go')).status, 200);

      const scoped = (name: string, companyId: string) => (store[name] ?? []).filter((r) => r.companyId === companyId);
      const repo = {
        getApproval: async (c: string, aid: string) => (scoped('approvals', c).find((r) => r.id === aid) as never) ?? null,
        getAgent: async (c: string, aid: string) => (scoped('agents', c).find((r) => r.id === aid) as never) ?? null,
        getIssues: async (c: string, ids: string[]) => scoped('issues', c).filter((r) => ids.includes(r.id as string)) as never,
        getActivity: async (c: string) => scoped('activityLog', c) as never,
        getCompanySettings: async () => ({}),
        getSecretValues: async () => ({ values: [], vaultUnavailable: false }),
      };
      const d = await detail.loadApprovalDetail(repo, 'company-a', id);
      assert.ok(d);
      const kinds = d.history.map((e) => e.kind);
      assert.deepEqual(kinds, ['created', 'issue_halted', 'decided', 'issue_released']);
      const created = d.history[0];
      const decided = d.history[2];
      assert.deepEqual([created.source, created.actor, created.note], ['activity_log', 'Alice', 'Please ship v2']);
      assert.deepEqual([decided.source, decided.actor, decided.text, decided.note], ['activity_log', 'Board', 'Approved', 'Go']);
      const times = d.history.map((e) => e.at!.getTime());
      assert.deepEqual(times, [...times].sort((a, b) => a - b));
      // Other company sees nothing.
      assert.equal(await detail.loadApprovalDetail(repo, 'company-b', id), null);
    });
  });
});
