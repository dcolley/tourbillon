/**
 * APR-FIX: route-level tests for what an approval decision does to its linked issues.
 * Covers create → Board decide, HITLy resume and MCP `decide_approval` (through the MCP route) with an
 * in-memory db, including concurrent decisions on one approval.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

// ---- in-memory db ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
type Cond =
  | { op: 'eq'; c: string; val: unknown }
  | { op: 'and'; xs: Array<Cond | undefined> }
  | { op: 'or'; xs: Array<Cond | undefined> }
  | { op: 'in'; c: string; vals: unknown[] }
  | { op: 'fn'; f: (row: Row) => boolean }
  | { op: 'any' };
type Order = { op: 'order'; c: string; dir: 1 | -1 };
const store: Record<string, Row[]> = {};
let nextId = 1;
function table(name: string) {
  return new Proxy({ __table: name } as Record<string, unknown>, {
    get: (t, prop: string) => (prop === '__table' ? name : { c: prop }),
  });
}
function match(row: Row, cond?: Cond): boolean {
  if (!cond || cond.op === 'any') return true;
  if (cond.op === 'eq') return row[cond.c] === cond.val;
  if (cond.op === 'in') return cond.vals.includes(row[cond.c]);
  if (cond.op === 'fn') return cond.f(row);
  if (cond.op === 'or') return cond.xs.some((x) => x !== undefined && match(row, x));
  return cond.xs.every((x) => x === undefined || match(row, x));
}
const tables = Object.fromEntries(
  ['approvals', 'agents', 'companies', 'issues', 'activityLog', 'hitlEvents', 'hitlLinkTokens'].map((n) => [n, table(n)]),
);
const nameOf = (t: unknown) => (t as { __table: string }).__table;
/** A query result that is awaitable and also offers `.returning()`. */
function result<T>(run: () => T) {
  return { then: (res: (v: T) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(run).then(res, rej), returning: async () => run() };
}
/** Unique keys the real schema enforces (a key with a null part is not checked, like Postgres). */
const UNIQUE: Record<string, string[][]> = {
  approvals: [['id'], ['companyId', 'requestedByAgentId', 'idempotencyKey']],
  hitlEvents: [['approvalId', 'seq']],
  hitlLinkTokens: [['token'], ['approvalId', 'itemRef', 'reviewerId']],
};
const DEFAULTS: Record<string, Row> = { hitlLinkTokens: { itemRef: '' } };
/** Every `where` used on an issues update, to check company scoping. */
const issueUpdateConds: Cond[] = [];
/** When `n > 0`, approval reads are held until `n` callers are waiting (forces a check-then-act race). */
const raceGate: { n: number; waiting: Array<() => void> } = { n: 0, waiting: [] };
function holdForRace(): Promise<void> {
  if (raceGate.n <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    raceGate.waiting.push(resolve);
    if (raceGate.waiting.length >= raceGate.n) {
      const all = raceGate.waiting.splice(0);
      raceGate.n = 0;
      all.forEach((r) => r());
    }
  });
}
const flatConds = (c: Cond): Cond[] => (c.op === 'and' ? c.xs.flatMap((x) => (x ? flatConds(x) : [])) : [c]);
function selectChain(name: string, fields?: Record<string, unknown>) {
  let join: { name: string; cond: Cond } | undefined;
  let cond: Cond | undefined;
  let order: Order | undefined;
  let lim: number | undefined;
  const run = () => {
    let rows = (store[name] ?? []).filter((r) => match(r, cond)).map((r) => ({ ...r }));
    if (order) {
      const { c, dir } = order;
      rows.sort((a, b) => ((a[c] as number) > (b[c] as number) ? dir : (a[c] as number) < (b[c] as number) ? -dir : 0));
    }
    if (lim !== undefined) rows = rows.slice(0, lim);
    if (!join) return rows;
    // leftJoin on eq(base.col, joined.col), shaped like select({ a: baseTable, b: joinedTable }).
    const j = join;
    const on = j.cond as { c: string; val: { c: string } };
    const keys = Object.entries(fields ?? {});
    return rows.map((r) => {
      const other = (store[j.name] ?? []).find((o) => o[on.val.c] === r[on.c]);
      return Object.fromEntries(keys.map(([k, t]) => [k, nameOf(t) === name ? r : other ? { ...other } : null]));
    });
  };
  const chain = {
    leftJoin: (t: unknown, c: Cond) => ((join = { name: nameOf(t), cond: c }), chain),
    where: (c: Cond) => ((cond = c), chain),
    orderBy: (o: Order) => ((order = o && o.op === 'order' ? o : undefined), chain),
    limit: (n: number) => ((lim = n), chain),
    for: () => chain,
    then: (res: (v: Row[]) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(run).then(res, rej),
  };
  return chain;
}
const ops = {
  select: (fields?: Record<string, unknown>) => ({ from: (t: unknown) => selectChain(nameOf(t), fields) }),
  update: (t: unknown) => ({
    set: (v: Row) => ({
      where: (cond: Cond) =>
        result(() => {
          if (nameOf(t) === 'issues') issueUpdateConds.push(cond);
          const rows = (store[nameOf(t)] ?? []).filter((r) => match(r, cond));
          rows.forEach((r) => Object.assign(r, v));
          return rows.map((r) => ({ ...r }));
        }),
    }),
  }),
  insert: (t: unknown) => ({
    values: (v: Row) => {
      let doNothing = false;
      const run = () => {
        const name = nameOf(t);
        const row: Row = { id: `row-${nextId++}`, createdAt: new Date(), ...(DEFAULTS[name] ?? {}), ...v };
        for (const key of UNIQUE[name] ?? []) {
          if (key.some((k) => row[k] === null || row[k] === undefined)) continue;
          if ((store[name] ?? []).some((r) => key.every((k) => r[k] === row[k]))) {
            if (doNothing) return [];
            throw new Error(`duplicate key value violates unique constraint (${name})`);
          }
        }
        (store[name] ??= []).push(row);
        return [{ ...row }];
      };
      const r = {
        then: (res: (v: Row[]) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(run).then(res, rej),
        returning: async () => run(),
        onConflictDoNothing: () => ((doNothing = true), r),
      };
      return r;
    },
  }),
};
const fakeDb = {
  ...ops,
  query: new Proxy({}, {
    get: (_t, name: string) => ({
      findFirst: async ({ where }: { where?: Cond } = {}) => {
        if (name === 'approvals') await holdForRace();
        const row = (store[name] ?? []).find((r) => match(r, where));
        return row ? { ...row } : undefined;
      },
    }),
  }),
  transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(ops),
};

// ---- side-effect recorders --------------------------------------------------------------------
const wakes: Array<{ agentId: string; companyId: string; linkedIssueIds?: string[]; status: string }> = [];
let wakeOutcome: Record<string, { outcome: string; skipReason?: string }> = {};
/** When set, every wake call throws (scheduler down). */
let schedulerDown = false;
const comments: Array<{ issueId: string; companyId: string; body: string }> = [];

type Handler = (req: NextRequest, c: { params: Promise<any> }) => Promise<Response>;
const routes: Record<string, Record<string, Handler>> = {};
const libs: Record<string, any> = {};
const ctx = <T>(params: T) => ({ params: Promise.resolve(params) });

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'localhost:3001', ...headers },
    body: JSON.stringify(body),
  });
}

const issueById = (id: string) => store.issues.find((r) => r.id === id)!;
const commentFor = (issueId: string) => comments.filter((c) => c.issueId === issueId).map((c) => c.body).join('\n---\n');

describe('APR-FIX approval decision restore (routes)', () => {
  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    const is = (id: string, name: string) => id === `@/lib/${name}` || id.endsWith(`/lib/${name}`);
    const noop = () => ({ op: 'any' });
    const mocks: Record<string, unknown> = {
      '@tourbillon/db': { db: fakeDb, ...tables },
      'drizzle-orm': {
        eq: (col: { c: string }, val: unknown) => ({ op: 'eq', c: col.c, val }),
        and: (...xs: Cond[]) => ({ op: 'and', xs }),
        inArray: (col: { c: string }, vals: unknown[]) => ({ op: 'in', c: col.c, vals }),
        or: (...xs: Cond[]) => ({ op: 'or', xs }),
        isNull: (col: { c: string }) => ({ op: 'fn', f: (r: Row) => r[col.c] === null || r[col.c] === undefined }),
        isNotNull: (col: { c: string }) => ({ op: 'fn', f: (r: Row) => r[col.c] !== null && r[col.c] !== undefined }),
        lte: (col: { c: string }, val: Date) => ({ op: 'fn', f: (r: Row) => r[col.c] != null && (r[col.c] as Date) <= val }),
        gt: (col: { c: string }, val: Date) => ({ op: 'fn', f: (r: Row) => r[col.c] != null && (r[col.c] as Date) > val }),
        asc: (col: { c: string }) => ({ op: 'order', c: col.c, dir: 1 }),
        desc: (col: { c: string }) => ({ op: 'order', c: col.c, dir: -1 }),
        gte: noop, ilike: noop, sql: noop,
      },
    };
    Module.prototype.require = function (id: string) {
      if (id in mocks) return mocks[id];
      if (is(id, 'wake-client')) {
        return {
          enqueueApprovalWake: async (data: (typeof wakes)[number]) => {
            if (schedulerDown) throw new Error('connect ECONNREFUSED scheduler-detail-XYZZY');
            wakes.push(data);
            return { jobId: '', runId: '', ...(wakeOutcome[data.agentId] ?? { outcome: 'created' }) };
          },
        };
      }
      if (is(id, 'issue-comments')) {
        return {
          addIssueComment: async (issueId: string, companyId: string, _author: unknown, body: string) => {
            comments.push({ issueId, companyId, body });
          },
        };
      }
      if (is(id, 'board-route-auth')) {
        return { requireBoardCompany: async () => ({ ok: true, value: { id: 'company-a' } }) };
      }
      if (is(id, 'auth/agent-token-auth')) {
        return { authenticateAgentToken: async () => ({ agentId: 'agent-req', companyId: 'company-a', runId: 'run-1' }) };
      }
      if (is(id, 'hitly/client')) return { ingestHitlyApproval: async () => 'hitly-1' };
      if (is(id, 'mobile-auth')) return { verifyMobileToken: async () => 'company-a' };
      // MCP route imports these for other tools only.
      for (const lib of ['agents', 'llm-providers', 'heartbeats', 'observability', 'jobs', 'issues', 'goals', 'projects', 'heartbeat']) {
        if (is(id, lib)) return {};
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };

    routes.create = await import('../companies/[companyId]/approvals/route');
    routes.decide = await import('./[approvalId]/decide/route');
    routes.hitly = await import('./[approvalId]/hitly-resume/route');
    routes.mcp = await import('../mcp/route');
    routes.get = await import('../companies/[companyId]/approvals/[approvalId]/route');
    routes.open = await import('../../o/[token]/route');
    libs.expiry = await import('../../../lib/approval-expiry');
    libs.host = await import('../../../lib/hitl-host');
  });

  beforeEach(() => {
    wakes.length = 0;
    comments.length = 0;
    wakeOutcome = {};
    schedulerDown = false;
    issueUpdateConds.length = 0;
    raceGate.n = 0;
    raceGate.waiting.length = 0;
    store.companies = [{ id: 'company-a', name: 'A', settings: {} }, { id: 'company-b', name: 'B', settings: {} }];
    store.agents = [
      { id: 'agent-req', companyId: 'company-a', name: 'CEO', status: 'active' },
      { id: 'agent-dev', companyId: 'company-a', name: 'Dev', status: 'active' },
      { id: 'agent-paused', companyId: 'company-a', name: 'Sleepy', status: 'paused' },
      { id: 'agent-other', companyId: 'company-b', name: 'Other', status: 'active' },
    ];
    store.issues = [];
    store.approvals = [];
    store.activityLog = [];
    store.hitlEvents = [];
    store.hitlLinkTokens = [];
  });

  function addIssue(over: Row): Row {
    const row = {
      companyId: 'company-a',
      status: 'todo',
      boardApprovalId: null,
      blockedByIssueIds: [],
      assigneeAgentId: null,
      ...over,
    };
    store.issues.push(row);
    return row;
  }

  async function createApproval(issueIds: string[]): Promise<string> {
    const res = await routes.create.POST(
      jsonRequest('/api/companies/company-a/approvals', { type: 'request_board_approval', issueIds, payload: { title: 'Ship it' } }, { authorization: 'Bearer test' }),
      ctx({ companyId: 'company-a' }),
    );
    assert.equal(res.status, 201);
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  const boardDecide = (approvalId: string, decision: 'approved' | 'rejected') =>
    routes.decide.POST(jsonRequest(`/api/approvals/${approvalId}/decide`, { decision }), ctx({ approvalId }));

  async function hitlyDecide(approvalId: string, decision: 'accept' | 'reject') {
    const appr = store.approvals.find((a) => a.id === approvalId)!;
    appr.payload = { ...(appr.payload as Row), hitlyResumeToken: 'tok' };
    return routes.hitly.POST(
      jsonRequest(`/api/approvals/${approvalId}/hitly-resume?token=tok`, { decision, id: undefined, metadata: {} }),
      ctx({ approvalId }),
    );
  }

  const mcpDecide = (approvalId: string, decision: 'approved' | 'rejected') =>
    routes.mcp.POST(
      jsonRequest('/api/mcp', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'decide_approval', arguments: { company_id: 'company-a', approval_id: approvalId, decision } },
      }),
      ctx({}),
    );

  type Path = 'board' | 'hitly' | 'mcp';
  const PATHS: Path[] = ['board', 'hitly', 'mcp'];
  function decideVia(path: Path, approvalId: string, decision: 'approved' | 'rejected') {
    if (path === 'board') return boardDecide(approvalId, decision);
    if (path === 'hitly') return hitlyDecide(approvalId, decision === 'approved' ? 'accept' : 'reject');
    return mcpDecide(approvalId, decision);
  }
  /** Did this response apply the decision (vs. the path's existing "already decided" answer)? */
  async function applied(path: Path, res: Response): Promise<boolean> {
    const body = (await res.json()) as Record<string, any>;
    if (path === 'board') {
      if (res.status === 409) {
        assert.deepEqual(body, { error: 'Already decided' });
        return false;
      }
      assert.equal(res.status, 200);
      return true;
    }
    if (path === 'hitly') {
      assert.equal(res.status, 200);
      if (body.alreadyDecided) {
        assert.deepEqual(body, { status: 'ok', alreadyDecided: true });
        return false;
      }
      return true;
    }
    if (body.error) {
      assert.equal(body.error.message, 'Approval already decided');
      return false;
    }
    assert.ok(body.result, JSON.stringify(body));
    return true;
  }
  const ACTOR: Record<Path, string> = { board: 'board', hitly: 'hitly', mcp: 'mcp' };
  const activity = (action: string) => store.activityLog.filter((a) => a.action === action);
  /** issue.updated rows written by a decision (creation writes its own halt row). */
  const decisionUpdates = () => activity('issue.updated').filter((a) => 'decision' in ((a.details ?? {}) as Row));

  for (const path of PATHS) {
    const approve = (id: string) => decideVia(path, id, 'approved');

    describe(`APR-FIX ${path} decision restores linked issues`, () => {
      it('already blocked → approval created → approved ends todo, comment states it', async () => {
        addIssue({ id: 'i1', identifier: 'TB-1', status: 'blocked' });
        const approvalId = await createApproval(['i1']);
        const saved = (store.approvals[0].payload as { priorStatuses: Record<string, string> }).priorStatuses;
        assert.equal(saved.i1, 'blocked', 'creation still records the blocked status');
        assert.equal(issueById('i1').boardApprovalId, approvalId);

        assert.equal((await approve(approvalId)).status, 200);
        assert.equal(issueById('i1').status, 'todo');
        assert.equal(issueById('i1').boardApprovalId, null);
        assert.match(commentFor('i1'), /Status restored to todo\./);
        assert.doesNotMatch(commentFor('i1'), /unhalted/);
      });

      it('with an unfinished dependency it stays blocked and the comment names the blocker key', async () => {
        addIssue({ id: 'dep', identifier: 'TB-7', status: 'in_progress' });
        addIssue({ id: 'dep-done', identifier: 'TB-8', status: 'done' });
        addIssue({ id: 'i1', identifier: 'TB-1', status: 'blocked', blockedByIssueIds: ['dep', 'dep-done'], assigneeAgentId: 'agent-dev' });
        const approvalId = await createApproval(['i1']);

        await approve(approvalId);
        assert.equal(issueById('i1').status, 'blocked');
        assert.equal(issueById('i1').boardApprovalId, null, 'halt is cleared even though it stays blocked');
        assert.match(commentFor('i1'), /Still blocked by TB-7 \(unfinished dependency\)/);
        assert.doesNotMatch(commentFor('i1'), /TB-8/);
        assert.deepEqual(wakes.map((w) => w.agentId), ['agent-req'], 'no assignee wake while still blocked');
      });

      it('dependency in another company does not count', async () => {
        addIssue({ id: 'dep-b', companyId: 'company-b', identifier: 'OB-1', status: 'todo' });
        addIssue({ id: 'i1', identifier: 'TB-1', status: 'blocked', blockedByIssueIds: ['dep-b'] });
        await approve(await createApproval(['i1']));
        assert.equal(issueById('i1').status, 'todo');
        assert.doesNotMatch(commentFor('i1'), /OB-1/);
      });

      it('saved in_progress comes back as in_progress', async () => {
        addIssue({ id: 'i1', identifier: 'TB-1', status: 'in_progress' });
        await approve(await createApproval(['i1']));
        assert.equal(issueById('i1').status, 'in_progress');
      });

      it('wakes the assignee as well as the requester (once each)', async () => {
        addIssue({ id: 'i1', identifier: 'TB-1', status: 'todo', assigneeAgentId: 'agent-dev' });
        addIssue({ id: 'i2', identifier: 'TB-2', status: 'todo', assigneeAgentId: 'agent-req' });
        await approve(await createApproval(['i1', 'i2']));
        assert.deepEqual(
          wakes.map((w) => [w.agentId, w.linkedIssueIds]),
          [['agent-req', ['i1', 'i2']], ['agent-dev', ['i1']]],
        );
        assert.ok(wakes.every((w) => w.companyId === 'company-a' && w.status === 'approved'));
        assert.equal(store.activityLog.filter((a) => a.action === 'issue.wake_skipped').length, 0);
      });

      it('paused assignee: no wake sent, skipped wake written to the issue activity', async () => {
        addIssue({ id: 'i1', identifier: 'TB-1', status: 'blocked', assigneeAgentId: 'agent-paused' });
        await approve(await createApproval(['i1']));
        assert.deepEqual(wakes.map((w) => w.agentId), ['agent-req']);
        const skipped = store.activityLog.filter((a) => a.action === 'issue.wake_skipped');
        assert.equal(skipped.length, 1);
        assert.equal(skipped[0].companyId, 'company-a');
        assert.equal(skipped[0].entityType, 'issue');
        assert.equal(skipped[0].entityId, 'i1');
        const details = skipped[0].details as Record<string, unknown>;
        assert.equal(details.agentId, 'agent-paused');
        assert.equal(details.role, 'assignee');
        assert.equal(details.reason, 'paused');
        assert.match(String(details.comment), /assignee agent Sleepy is paused, so nobody will pick this issue up/);
        assert.equal(details.note, undefined, 'no decision note copied');
      });

      it('scheduler skip is recorded too (category only)', async () => {
        wakeOutcome['agent-dev'] = { outcome: 'skipped', skipReason: 'agent status archived' };
        addIssue({ id: 'i1', identifier: 'TB-1', status: 'todo', assigneeAgentId: 'agent-dev' });
        await approve(await createApproval(['i1']));
        const skipped = store.activityLog.filter((a) => a.action === 'issue.wake_skipped');
        assert.equal(skipped.length, 1);
        assert.equal((skipped[0].details as Row).reason, 'archived');
      });

      it('assignee from another company is never woken', async () => {
        addIssue({ id: 'i1', identifier: 'TB-1', status: 'todo', assigneeAgentId: 'agent-other' });
        await approve(await createApproval(['i1']));
        assert.deepEqual(wakes.map((w) => w.agentId), ['agent-req']);
        const skipped = store.activityLog.filter((a) => a.action === 'issue.wake_skipped');
        assert.equal(skipped.length, 1);
        assert.equal((skipped[0].details as Row).reason, 'agent_not_found');
      });

      it('rejected keeps it blocked and wakes only the requester', async () => {
        addIssue({ id: 'i1', identifier: 'TB-1', status: 'todo', assigneeAgentId: 'agent-dev' });
        const approvalId = await createApproval(['i1']);
        await decideVia(path, approvalId, 'rejected');
        assert.equal(issueById('i1').status, 'blocked');
        assert.deepEqual(wakes.map((w) => w.agentId), ['agent-req']);
        assert.match(commentFor('i1'), /remains blocked/);
      });
    });
  }

  for (const path of PATHS) {
    describe(`APR-FIX ${path} decision: claim, scoping and activity`, () => {
      it('two simultaneous decisions: one applies, the other gets the already-decided answer with no side effects', async () => {
        addIssue({ id: 'i1', identifier: 'TB-1', status: 'blocked', assigneeAgentId: 'agent-dev' });
        const approvalId = await createApproval(['i1']);
        raceGate.n = 2;
        const results = await Promise.all([decideVia(path, approvalId, 'approved'), decideVia(path, approvalId, 'approved')]);
        const wins = await Promise.all(results.map((r) => applied(path, r)));
        assert.equal(wins.filter(Boolean).length, 1, 'exactly one winner');
        assert.equal(comments.length, 1, 'exactly one comment');
        assert.deepEqual(wakes.map((w) => w.agentId).sort(), ['agent-dev', 'agent-req'], 'one wake each');
        assert.equal(decisionUpdates().length, 1, 'one issue.updated row');
        assert.equal(issueById('i1').status, 'todo');
        assert.equal(store.approvals[0].status, 'approved');
      });

      it('linked issue in another company: never read, updated, commented on or given activity', async () => {
        addIssue({ id: 'i1', identifier: 'TB-1', status: 'blocked' });
        // Spoofed link: a company-b issue that even claims to be held by this approval.
        addIssue({ id: 'xb', companyId: 'company-b', identifier: 'OB-1', status: 'blocked', assigneeAgentId: 'agent-other', boardApprovalId: 'ap-x' });
        store.approvals.push({
          id: 'ap-x', companyId: 'company-a', type: 'request_board_approval', status: 'pending',
          requestedByAgentId: 'agent-paused', issueIds: ['i1', 'xb'], payload: { title: 'Ship it', priorStatuses: { i1: 'blocked', xb: 'todo' } },
        });
        assert.ok(await applied(path, await decideVia(path, 'ap-x', 'approved')));

        assert.equal(issueById('i1').status, 'todo');
        assert.equal(issueById('xb').status, 'blocked');
        assert.equal(issueById('xb').boardApprovalId, 'ap-x');
        assert.deepEqual(store.activityLog.filter((a) => a.entityId === 'xb'), [], 'no activity of any kind on the other company issue');
        assert.deepEqual(comments.map((c) => c.issueId), ['i1']);
        assert.ok(!wakes.some((w) => w.agentId === 'agent-other'));
        // Requester is paused: the skip is recorded on the known issue only.
        assert.deepEqual(activity('issue.wake_skipped').map((a) => a.entityId), ['i1']);
        assert.ok(issueUpdateConds.length > 0);
        for (const cond of issueUpdateConds) {
          assert.ok(
            flatConds(cond).some((c) => c.op === 'eq' && c.c === 'companyId' && c.val === 'company-a'),
            'every issue status write is company scoped',
          );
        }
      });

      it('issue.updated row: one per restored issue, company scoped, with the decision', async () => {
        addIssue({ id: 'i1', identifier: 'TB-1', status: 'blocked' });
        const approvalId = await createApproval(['i1']);
        await decideVia(path, approvalId, 'approved');
        const rows = decisionUpdates();
        assert.equal(rows.length, 1);
        const [row] = rows;
        assert.equal(row.companyId, 'company-a');
        assert.equal(row.actorType, 'system');
        assert.equal(row.actorId, ACTOR[path]);
        assert.equal(row.entityType, 'issue');
        assert.equal(row.entityId, 'i1');
        const details = row.details as Row;
        assert.equal(details.status, 'todo');
        assert.equal(details.boardApprovalId, null);
        assert.equal(details.approvalId, approvalId);
        assert.equal(details.decision, 'approved');
        assert.ok(!('remainingBlockerIds' in details), 'no blocker ids when nothing blocks');
      });

      it('issue.updated row lists remainingBlockerIds when it stays blocked', async () => {
        addIssue({ id: 'dep', identifier: 'TB-7', status: 'todo' });
        addIssue({ id: 'i1', identifier: 'TB-1', status: 'blocked', blockedByIssueIds: ['dep'] });
        await decideVia(path, await createApproval(['i1']), 'approved');
        const [row] = decisionUpdates();
        assert.equal((row.details as Row).status, 'blocked');
        assert.deepEqual((row.details as Row).remainingBlockerIds, ['dep']);
      });

      it('saved in_progress but an unfinished blocker remains: stays blocked, says so, no assignee wake', async () => {
        addIssue({ id: 'dep', identifier: 'TB-7', status: 'in_review' });
        addIssue({ id: 'i1', identifier: 'TB-1', status: 'in_progress', blockedByIssueIds: ['dep'], assigneeAgentId: 'agent-dev' });
        const approvalId = await createApproval(['i1']);
        assert.equal((store.approvals[0].payload as Row & { priorStatuses: Row }).priorStatuses.i1, 'in_progress');
        await decideVia(path, approvalId, 'approved');
        assert.equal(issueById('i1').status, 'blocked');
        assert.equal(issueById('i1').boardApprovalId, null);
        assert.match(commentFor('i1'), /Still blocked by TB-7 \(unfinished dependency\)/);
        assert.deepEqual(wakes.map((w) => w.agentId), ['agent-req']);
      });

      for (const closed of ['done', 'cancelled'] as const) {
        for (const decision of ['approved', 'rejected'] as const) {
          it(`issue ${closed} while pending: ${decision} leaves the status alone`, async () => {
            addIssue({ id: 'i1', identifier: 'TB-1', status: 'blocked', assigneeAgentId: 'agent-dev' });
            const approvalId = await createApproval(['i1']);
            issueById('i1').status = closed;
            await decideVia(path, approvalId, decision);
            assert.equal(issueById('i1').status, closed);
            assert.equal(issueById('i1').boardApprovalId, null, 'halt still cleared');
            assert.match(commentFor('i1'), new RegExp(`Status unchanged \\(${closed}\\): this issue was already closed\\.`));
            assert.deepEqual(wakes.map((w) => w.agentId), ['agent-req'], 'no assignee wake for a closed issue');
          });
        }
      }

      it('wake_skipped details carry exactly the fixed keys (no scheduler text)', async () => {
        wakeOutcome['agent-dev'] = { outcome: 'skipped', skipReason: 'agent status paused: scheduler-detail-XYZZY' };
        addIssue({ id: 'i1', identifier: 'TB-1', status: 'todo', assigneeAgentId: 'agent-dev' });
        await decideVia(path, await createApproval(['i1']), 'approved');
        const [row] = activity('issue.wake_skipped');
        assert.deepEqual(Object.keys(row.details as Row).sort(), ['agentId', 'approvalId', 'comment', 'reason', 'role']);
        assert.doesNotMatch(JSON.stringify(row.details), /XYZZY/);
      });

      it('scheduler down: decision still applies, failed wakes are recorded without detail', async () => {
        schedulerDown = true;
        addIssue({ id: 'i1', identifier: 'TB-1', status: 'blocked', assigneeAgentId: 'agent-dev' });
        const approvalId = await createApproval(['i1']);
        assert.ok(await applied(path, await decideVia(path, approvalId, 'approved')));
        assert.equal(issueById('i1').status, 'todo');
        const failed = activity('issue.wake_failed');
        assert.deepEqual(failed.map((a) => [a.entityId, (a.details as Row).role]), [['i1', 'requester'], ['i1', 'assignee']]);
        for (const row of failed) {
          assert.equal(row.companyId, 'company-a');
          assert.deepEqual(Object.keys(row.details as Row).sort(), ['agentId', 'approvalId', 'comment', 'reason', 'role']);
          assert.equal((row.details as Row).reason, 'wake_failed');
          assert.doesNotMatch(JSON.stringify(row.details), /XYZZY|ECONNREFUSED/);
        }
        assert.match(String((failed[1].details as Row).comment), /assignee agent Dev, so nobody will pick this issue up/);
      });
    });
  }

  describe('APR-FIX concurrent decisions across paths', () => {
    it('3 Board + 3 HITLy + 2 MCP at once: one winner, one comment, one wake each', async () => {
      addIssue({ id: 'i1', identifier: 'TB-1', status: 'blocked', assigneeAgentId: 'agent-dev' });
      const approvalId = await createApproval(['i1']);
      const order: Path[] = ['board', 'hitly', 'mcp', 'board', 'hitly', 'mcp', 'board', 'hitly'];
      raceGate.n = order.length;
      const results = await Promise.all(order.map((p) => decideVia(p, approvalId, 'approved')));
      const wins = await Promise.all(results.map((r, i) => applied(order[i], r)));
      assert.equal(wins.filter(Boolean).length, 1);
      assert.equal(comments.length, 1);
      assert.equal(decisionUpdates().length, 1);
      assert.deepEqual(wakes.map((w) => w.agentId).sort(), ['agent-dev', 'agent-req']);
      assert.equal(issueById('i1').status, 'todo');
    });

    it('mixed approve/reject at once: the winning decision is the only one applied', async () => {
      addIssue({ id: 'i1', identifier: 'TB-1', status: 'blocked', assigneeAgentId: 'agent-dev' });
      const approvalId = await createApproval(['i1']);
      const calls: Array<[Path, 'approved' | 'rejected']> = [['board', 'rejected'], ['mcp', 'approved'], ['hitly', 'approved'], ['board', 'approved']];
      raceGate.n = calls.length;
      const results = await Promise.all(calls.map(([p, d]) => decideVia(p, approvalId, d)));
      const wins = await Promise.all(results.map((r, i) => applied(calls[i][0], r)));
      assert.equal(wins.filter(Boolean).length, 1);
      const decided = store.approvals[0].status;
      assert.equal(decided, calls[wins.indexOf(true)][1]);
      assert.equal(comments.length, 1);
      assert.equal(wakes.length, decided === 'approved' ? 2 : 1);
      assert.ok(wakes.every((w) => w.status === decided));
      assert.equal(issueById('i1').status, decided === 'approved' ? 'todo' : 'blocked');
    });
  });

  describe('APR-FIX every decide path uses the shared decision helper', () => {
    const root = join(__dirname, '..');
    const files = {
      decide: join(root, 'approvals/[approvalId]/decide/route.ts'),
      hitly: join(root, 'approvals/[approvalId]/hitly-resume/route.ts'),
      mcp: join(root, 'mcp/route.ts'),
    };
    for (const [name, file] of Object.entries(files)) {
      it(`${name} calls applyApprovalDecision and nothing lower-level`, () => {
        const src = readFileSync(file, 'utf8');
        assert.match(src, /from '@\/lib\/approval-decide'/);
        assert.match(src, /applyApprovalDecision\(\{/);
        assert.doesNotMatch(src, /restoreLinkedIssuesForDecision|wakeAgentsForDecision|formatApprovalDecisionComment/);
        assert.doesNotMatch(src, /priorStatuses\[issue\.id\]/, 'no inline restore rule left');
        assert.doesNotMatch(src, /enqueueApprovalWake\(/, 'wakes go through the helper');
        assert.doesNotMatch(src, /status: decision,|status: decided,/, 'approval status is only written by the claim');
      });
    }
    it('the claim is conditional on pending and company', () => {
      const src = readFileSync(join(__dirname, '../../../lib/approval-decide.ts'), 'utf8');
      assert.match(src, /eq\(approvals\.status, 'pending'\)/);
      assert.match(src, /eq\(approvals\.companyId, input\.companyId\)/);
      assert.match(src, /if \(!row\) return null;/);
    });
  });
  // ---- APR-2: hitl v0 questions ----------------------------------------------------------------
  describe('APR-2 hitl v0 questions', () => {
    const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();
    const binary = (over: Row = {}) => ({
      spec: 'hitl/request/v0',
      question: 'Issue a £240 refund for order 48213?',
      answerType: 'binary',
      options: [
        { value: 'approve', label: 'Approve' },
        { value: 'reject', label: 'Reject' },
      ],
      requester: { agentId: 'agent-req', runId: 'run-1' },
      ...over,
    });
    const single = (over: Row = {}) => ({
      spec: 'hitl/request/v0',
      question: 'Which carrier should ship the replacement?',
      answerType: 'single',
      options: [
        { value: 'dpd', label: 'DPD next day' },
        { value: 'evri', label: 'Evri' },
      ],
      recommended: { value: 'dpd', reason: 'Fastest.' },
      requester: { agentId: 'agent-req' },
      ...over,
    });
    const withLink = (over: Row = {}) =>
      binary({
        question: 'Renew the supplier contract?',
        context: {
          markdown: 'Renewal is up 6%.',
          links: [{ ref: 'lnk_terms', url: 'https://suppliers.example.com/terms/2027', label: 'Terms', mustOpen: true }],
        },
        ...over,
      });

    async function postHitl(hitl: unknown, issueIds: string[] = []) {
      const res = await routes.create.POST(
        jsonRequest('/api/companies/company-a/approvals', { type: 'request_board_approval', issueIds, hitl }, { authorization: 'Bearer test' }),
        ctx({ companyId: 'company-a' }),
      );
      return { res, body: (await res.json()) as Record<string, any> };
    }
    async function createHitl(hitl: unknown, issueIds: string[] = []): Promise<string> {
      const { res, body } = await postHitl(hitl, issueIds);
      assert.equal(res.status, 201, JSON.stringify(body));
      return body.id as string;
    }
    const decideJson = (approvalId: string, body: Row) =>
      routes.decide.POST(jsonRequest(`/api/approvals/${approvalId}/decide`, body), ctx({ approvalId }));
    const mcpCall = (name: string, args: Row) =>
      routes.mcp.POST(jsonRequest('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), ctx({}));
    const openReq = (token: string, method = 'GET') =>
      new NextRequest(`http://localhost/o/${token}`, { method, headers: { host: 'localhost:3001' } });
    const approvalRow = (id: string) => store.approvals.find((a) => a.id === id)!;

    describe('ingest (shared validation)', () => {
      it('stores the request with a host id and returns it', async () => {
        const { res, body } = await postHitl(binary({ deadline: inAnHour(), idempotencyKey: 'idem-1' }));
        assert.equal(res.status, 201);
        assert.equal(body.hitlRequest.id, body.id);
        assert.equal(body.hitlRequest.question, 'Issue a £240 refund for order 48213?');
        assert.equal(body.idempotencyKey, 'idem-1');
        assert.ok(approvalRow(body.id).deadline instanceof Date);
      });

      it('refuses an agent-sent id, unknown keys and a past deadline with field errors', async () => {
        for (const [hitl, field] of [
          [binary({ id: 'mine' }), '/id'],
          [binary({ colour: 'blue' }), ''],
          [binary({ deadline: '2020-01-01T00:00:00Z' }), '/deadline'],
          [binary({ requester: { agentId: 'agent-dev' } }), '/requester/agentId'],
        ] as const) {
          const { res, body } = await postHitl(hitl);
          assert.equal(res.status, 422, JSON.stringify(body));
          assert.equal(body.error, 'Invalid hitl request');
          assert.ok(Array.isArray(body.fields) && body.fields.length > 0);
          if (field) assert.ok(body.fields.some((f: { field: string }) => f.field === field), JSON.stringify(body.fields));
        }
        assert.equal(store.approvals.length, 0, 'nothing stored');
      });

      it('a repeat idempotencyKey returns the existing approval (200), one row', async () => {
        const first = await createHitl(binary({ idempotencyKey: 'idem-7' }));
        const { res, body } = await postHitl(binary({ idempotencyKey: 'idem-7' }));
        assert.equal(res.status, 200);
        assert.equal(body.id, first);
        assert.equal(store.approvals.length, 1);
      });
    });

    describe('answers', () => {
      it('binary approve: stored as approved, response answered/approve, wake carries it', async () => {
        addIssue({ id: 'i1', identifier: 'TB-1', status: 'todo' });
        const id = await createHitl(binary(), ['i1']);
        const res = await decideJson(id, { decision: 'approved' });
        assert.equal(res.status, 200);
        const row = approvalRow(id);
        assert.equal(row.status, 'approved');
        const r = row.hitlResponse as Row;
        assert.equal(r.status, 'answered');
        assert.equal(r.value, 'approve');
        assert.equal(r.signature, null);
        assert.deepEqual(r.decidedBy, { kind: 'group', id: 'board', display: 'Board' });
        assert.equal(issueById('i1').status, 'todo');
        const wake = wakes[0] as Row;
        assert.equal(wake.status, 'approved');
        assert.deepEqual((wake.response as Row).value, 'approve');
        assert.equal((wake.response as Row).status, 'answered');
      });

      it('binary reject needs a reason by default (422), then succeeds with one', async () => {
        const id = await createHitl(binary());
        const bad = await decideJson(id, { decision: 'rejected' });
        assert.equal(bad.status, 422);
        const body = (await bad.json()) as Row;
        assert.ok((body.fields as Array<{ field: string }>).some((f) => f.field === '/reason'));
        assert.equal(approvalRow(id).status, 'pending');
        assert.equal((await decideJson(id, { decision: 'rejected', reason: 'Not this quarter' })).status, 200);
        assert.equal((approvalRow(id).hitlResponse as Row).reason, 'Not this quarter');
      });

      it('single choice: answered with the value; issues restored; a bad value is refused', async () => {
        addIssue({ id: 'i1', identifier: 'TB-1', status: 'todo' });
        const id = await createHitl(single(), ['i1']);
        const bad = await decideJson(id, { status: 'answered', value: 'ups' });
        assert.equal(bad.status, 422);
        const legacy = await decideJson(id, { decision: 'approved' });
        assert.equal(legacy.status, 422, 'approve/reject only fits binary questions');
        const ok = await decideJson(id, { status: 'answered', value: 'evri' });
        assert.equal(ok.status, 200);
        assert.equal(approvalRow(id).status, 'answered');
        assert.equal((approvalRow(id).hitlResponse as Row).value, 'evri');
        assert.equal(issueById('i1').status, 'todo');
        assert.equal((wakes[0] as Row).status, 'answered');
        assert.equal(((wakes[0] as Row).response as Row).value, 'evri');
        assert.match(commentFor('i1'), /evri|Evri/);
      });

      it('declined keeps issues blocked and passes the reason on', async () => {
        addIssue({ id: 'i1', identifier: 'TB-1', status: 'todo' });
        const id = await createHitl(single(), ['i1']);
        assert.equal((await decideJson(id, { status: 'declined', reason: 'Ask the customer first' })).status, 200);
        const r = approvalRow(id).hitlResponse as Row;
        assert.equal(r.status, 'declined');
        assert.equal(r.value, undefined);
        assert.equal(r.reason, 'Ask the customer first');
        assert.equal(issueById('i1').status, 'blocked');
        assert.equal(((wakes[0] as Row).response as Row).reason, 'Ask the customer first');
      });

      it('secret: an answer is refused (no device encryption yet); declining works', async () => {
        const id = await createHitl({
          spec: 'hitl/request/v0',
          question: 'What is the API key for the billing sandbox?',
          answerType: 'secret',
          encryption: { publicKey: 'aUe06yud5-sO8Pp2F300oD5PJQpZE_muFRiArmDNsi8', alg: 'HPKE-X25519-SHA256-AES128GCM' },
          requester: { agentId: 'agent-req' },
        });
        assert.equal((await decideJson(id, { status: 'answered', value: 'k' })).status, 422);
        assert.equal((await decideJson(id, { status: 'declined' })).status, 200);
      });

      it('MCP decide_approval takes status + value and returns the response', async () => {
        const id = await createHitl(single());
        const res = await mcpCall('decide_approval', { company_id: 'company-a', approval_id: id, status: 'answered', value: 'dpd' });
        const body = JSON.stringify(await res.json());
        assert.doesNotMatch(body, /"error"/);
        assert.equal(approvalRow(id).status, 'answered');
        assert.deepEqual((approvalRow(id).hitlResponse as Row).decidedBy, { kind: 'service', id: 'mcp', display: 'MCP' });
      });

      it('dashboard form errors redirect back to the approval page with a message', async () => {
        const id = await createHitl(single());
        const form = new FormData();
        form.set('status', 'answered');
        form.set('value', 'nope');
        form.set('returnTo', `/approval/${id}`);
        const res = await routes.decide.POST(
          new NextRequest(`http://localhost/api/approvals/${id}/decide`, { method: 'POST', headers: { accept: 'text/html', host: 'localhost:3001' }, body: form }),
          ctx({ approvalId: id }),
        );
        assert.equal(res.status, 303);
        const loc = new URL(res.headers.get('location')!);
        assert.equal(loc.pathname, `/approval/${id}`);
        assert.equal(loc.searchParams.get('for'), id);
        assert.ok(loc.searchParams.get('decideError'));
      });
    });

    describe('expiry', () => {
      it('past deadline: lazy expiry on decide; response has no value, decidedBy or decidedAt; agent told', async () => {
        addIssue({ id: 'i1', identifier: 'TB-1', status: 'todo' });
        const id = await createHitl(binary({ deadline: inAnHour() }), ['i1']);
        approvalRow(id).deadline = new Date(Date.now() - 1000);
        const res = await decideJson(id, { decision: 'approved' });
        assert.equal(res.status, 409);
        assert.deepEqual(await res.json(), { error: 'Expired', status: 'expired' });
        const row = approvalRow(id);
        assert.equal(row.status, 'expired');
        const r = row.hitlResponse as Row;
        assert.equal(r.status, 'expired');
        for (const k of ['value', 'decidedBy', 'decidedAt', 'reason']) assert.ok(!(k in r), k);
        assert.equal(issueById('i1').status, 'blocked');
        assert.deepEqual(wakes.map((w) => [w.agentId, w.status]), [['agent-req', 'expired']]);
      });

      for (const order of ['decide first', 'expiry first'] as const) {
        it(`race: decide vs expiry sweep (${order}): exactly one wins, one comment, one wake`, async () => {
          addIssue({ id: 'i1', identifier: 'TB-1', status: 'blocked' });
          const id = await createHitl(binary({ deadline: inAnHour() }), ['i1']);
          const later = new Date(Date.now() + 2 * 3600_000);
          const decide = () => decideJson(id, { decision: 'approved' });
          const expire = () => libs.expiry.expireApprovalIfDue('company-a', id, later) as Promise<boolean>;
          const [a, b] = order === 'decide first' ? await Promise.all([decide(), expire()]) : (await Promise.all([expire(), decide()])).reverse() as [Response, boolean];
          const decided = (a as Response).status === 200;
          const expired = b as boolean;
          assert.equal(Number(decided) + Number(expired), 1, `exactly one winner (decide ${a.status}, expired ${b})`);
          assert.equal(approvalRow(id).status, decided ? 'approved' : 'expired');
          assert.equal(comments.length, 1);
          assert.equal(wakes.length, 1);
          assert.equal(store.hitlEvents.filter((e) => e.type === 'decided').length, decided ? 1 : 0);
        });
      }

      it('sweep expires only due approvals in its own company', async () => {
        const due = await createHitl(binary({ deadline: inAnHour() }));
        const notDue = await createHitl(binary({ deadline: inAnHour(), question: 'Second?' }));
        approvalRow(due).deadline = new Date(Date.now() - 1000);
        store.approvals.push({ id: 'b-due', companyId: 'company-b', status: 'pending', type: 'request_board_approval', requestedByAgentId: 'agent-other', issueIds: [], payload: {}, deadline: new Date(0) });
        const ids = await libs.expiry.expireDueApprovals('company-a');
        assert.deepEqual(ids, [due]);
        assert.equal(approvalRow(notDue).status, 'pending');
        assert.equal(approvalRow('b-due').status, 'pending');
      });
    });

    describe('company scoping', () => {
      it('another company approval: Board decide 404, MCP decide refused, nothing changes', async () => {
        store.approvals.push({ id: 'b-1', companyId: 'company-b', status: 'pending', type: 'request_board_approval', requestedByAgentId: 'agent-other', issueIds: [], payload: {}, hitlRequest: null });
        assert.equal((await decideJson('b-1', { decision: 'approved' })).status, 404);
        const mcp = (await (await mcpCall('decide_approval', { company_id: 'company-a', approval_id: 'b-1', decision: 'approved' })).json()) as Row;
        assert.ok(mcp.error, JSON.stringify(mcp));
        assert.equal(approvalRow('b-1').status, 'pending');
        assert.equal(store.hitlEvents.length, 0);
        assert.equal(wakes.length, 0);
      });

      it('/o: unknown, malformed and other-company tokens are 404 and record nothing', async () => {
        const id = await createHitl(withLink());
        store.hitlLinkTokens.push({ token: 'B'.repeat(43), companyId: 'company-b', approvalId: id, itemRef: 'lnk_terms', reviewerKind: 'group', reviewerId: 'board' });
        for (const token of ['B'.repeat(43), 'U'.repeat(43), 'bad token!']) {
          const res = await routes.open.GET(openReq(encodeURIComponent(token)), ctx({ token }));
          assert.equal(res.status, 404, token);
        }
        assert.equal(store.hitlEvents.length, 0);
      });
    });

    describe('/o/<token> links and mustOpen', () => {
      it('mustOpen blocks the answer until opened; HEAD does not count; GET redirects without a referrer', async () => {
        const id = await createHitl(withLink());
        const token = (await libs.host.linkTokenFor({ companyId: 'company-a', approvalId: id, itemRef: 'lnk_terms' })) as string;
        assert.equal(await libs.host.linkTokenFor({ companyId: 'company-a', approvalId: id, itemRef: 'lnk_terms' }), token, 'stable per reviewer');

        assert.equal((await decideJson(id, { decision: 'approved' })).status, 422, 'not opened yet');
        const head = await routes.open.HEAD(openReq(token, 'HEAD'), ctx({ token }));
        assert.equal(head.status, 303);
        assert.equal((await decideJson(id, { decision: 'approved' })).status, 422, 'HEAD is not an open');

        const res = await routes.open.GET(openReq(token), ctx({ token }));
        assert.equal(res.status, 303);
        assert.equal(res.headers.get('location'), 'https://suppliers.example.com/terms/2027');
        assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
        assert.equal((await decideJson(id, { decision: 'approved' })).status, 200);
        const r = approvalRow(id).hitlResponse as { activity: { items: Array<{ ref: string; openedAt: string[] }>; events: Array<{ type: string }> } };
        assert.equal(r.activity.items[0].ref, 'lnk_terms');
        assert.equal(r.activity.items[0].openedAt.length, 1);
        assert.deepEqual(r.activity.events.map((e) => e.type), ['opened', 'decided']);
      });

      it('events are hash-chained with increasing seq', async () => {
        const id = await createHitl(withLink());
        await libs.host.recordReviewerEvent({ companyId: 'company-a', approvalId: id, type: 'presented' });
        await libs.host.recordReviewerEvent({ companyId: 'company-a', approvalId: id, type: 'presented' });
        await libs.host.recordReviewerEvent({ companyId: 'company-a', approvalId: id, type: 'opened', itemRef: 'lnk_terms' });
        const evs = store.hitlEvents.filter((e) => e.approvalId === id);
        assert.deepEqual(evs.map((e) => e.type), ['presented', 'opened'], 'presented once');
        assert.deepEqual(evs.map((e) => e.seq), [1, 2]);
        assert.equal(evs[1].prevHash, evs[0].hash);
      });
    });

    describe('redaction', () => {
      it('no link token or HITLy resume token in API/MCP responses or logs', async () => {
        const logged: string[] = [];
        const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
        for (const k of Object.keys(saved) as Array<keyof typeof saved>) {
          console[k] = (...args: unknown[]) => logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
        }
        try {
          const id = await createHitl(withLink());
          approvalRow(id).payload = { ...(approvalRow(id).payload as Row), hitlyResumeToken: 'RESUME-SECRET-123' };
          const token = (await libs.host.linkTokenFor({ companyId: 'company-a', approvalId: id, itemRef: 'lnk_terms' })) as string;
          await routes.open.GET(openReq(token), ctx({ token }));
          await routes.open.GET(openReq(token.slice(0, -2) + 'zz'), ctx({ token: token.slice(0, -2) + 'zz' }));
          const responses = [
            await routes.get.GET(
              new NextRequest(`http://localhost/api/companies/company-a/approvals/${id}`, { headers: { authorization: 'Bearer test' } }),
              ctx({ companyId: 'company-a', approvalId: id }),
            ),
            await mcpCall('list_approvals', { company_id: 'company-a' }),
            await decideJson(id, { decision: 'approved' }),
          ];
          const bodies = await Promise.all(responses.map((r) => r.text()));
          assert.match(bodies[0], new RegExp(id));
          for (const b of bodies) {
            assert.doesNotMatch(b, /RESUME-SECRET-123/);
            assert.ok(!b.includes(token), 'link token never in a response');
          }
          const all = logged.join('\n');
          assert.ok(!all.includes(token), 'link token never logged');
          assert.doesNotMatch(all, /RESUME-SECRET-123/);
        } finally {
          Object.assign(console, saved);
        }
      });
    });
  });
});
