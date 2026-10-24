/**
 * APR-FIX: route-level tests for what an approval decision does to its linked issues.
 * Covers create → Board decide and HITLy resume with an in-memory db; the MCP path is checked by
 * source (it is not exported on its own) to use the same helper.
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
const ops = {
  select: () => ({
    from: (t: unknown) => ({ where: async (cond: Cond) => (store[nameOf(t)] ?? []).filter((r) => match(r, cond)).map((r) => ({ ...r })) }),
  }),
  update: (t: unknown) => ({
    set: (v: Row) => ({
      where: (cond: Cond) =>
        result(() => {
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
      return originalRequire.apply(this, arguments as unknown as [string]);
    };

    routes.create = await import('../companies/[companyId]/approvals/route');
    routes.decide = await import('./[approvalId]/decide/route');
    routes.hitly = await import('./[approvalId]/hitly-resume/route');
  });

  beforeEach(() => {
    wakes.length = 0;
    comments.length = 0;
    wakeOutcome = {};
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

  for (const path of ['board', 'hitly'] as const) {
    const approve = (id: string) => (path === 'board' ? boardDecide(id, 'approved') : hitlyDecide(id, 'accept'));

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
        await (path === 'board' ? boardDecide(approvalId, 'rejected') : hitlyDecide(approvalId, 'reject'));
        assert.equal(issueById('i1').status, 'blocked');
        assert.deepEqual(wakes.map((w) => w.agentId), ['agent-req']);
        assert.match(commentFor('i1'), /remains blocked/);
      });
    });
  }

  describe('APR-FIX every decide path uses the shared helper', () => {
    const root = join(__dirname, '..');
    const files = {
      decide: join(root, 'approvals/[approvalId]/decide/route.ts'),
      hitly: join(root, 'approvals/[approvalId]/hitly-resume/route.ts'),
      mcp: join(root, 'mcp/route.ts'),
    };
    for (const [name, file] of Object.entries(files)) {
      it(`${name} calls restoreLinkedIssuesForDecision and wakeAgentsForDecision`, () => {
        const src = readFileSync(file, 'utf8');
        assert.match(src, /from '@\/lib\/approval-restore-db'/);
        assert.match(src, /restoreLinkedIssuesForDecision\(tx,/);
        assert.match(src, /wakeAgentsForDecision\(\{/);
        assert.doesNotMatch(src, /priorStatuses\[issue\.id\]/, 'no inline restore rule left');
        assert.doesNotMatch(src, /unhalted \(status restored\)/);
        assert.doesNotMatch(src, /enqueueApprovalWake\(/, 'wakes go through the helper');
      });
    }
  });
});
