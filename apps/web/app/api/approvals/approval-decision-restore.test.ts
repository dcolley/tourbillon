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
type Cond = { op: 'eq'; c: string; val: unknown } | { op: 'and'; xs: Cond[] } | { op: 'in'; c: string; vals: unknown[] } | { op: 'any' };
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
  return cond.xs.every((x) => match(row, x));
}
const tables = Object.fromEntries(
  ['approvals', 'agents', 'companies', 'issues', 'activityLog'].map((n) => [n, table(n)]),
);
const nameOf = (t: unknown) => (t as { __table: string }).__table;
/** A query result that is awaitable and also offers `.returning()`. */
function result<T>(run: () => T) {
  return { then: (res: (v: T) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(run).then(res, rej), returning: async () => run() };
}
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
const flatConds = (c: Cond): Cond[] => (c.op === 'and' ? c.xs.flatMap(flatConds) : [c]);
const ops = {
  select: () => ({
    from: (t: unknown) => ({ where: async (cond: Cond) => (store[nameOf(t)] ?? []).filter((r) => match(r, cond)).map((r) => ({ ...r })) }),
  }),
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
    values: (v: Row) =>
      result(() => {
        const row = { id: `row-${nextId++}`, createdAt: new Date(), ...v };
        (store[nameOf(t)] ??= []).push(row);
        return [{ ...row }];
      }),
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
        or: noop, desc: noop, gte: noop, ilike: noop, sql: noop,
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
});
