/**
 * WC2: buildWakeContext (DB assembly) against an in-memory repo built from the sanitised
 * TOUR-531 rows, plus targeted cases. createDrizzleWakeContextRepo is checked against drizzle's
 * real query builder with a recording fake client (no database is touched).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/postgres-js';
import { activityLog, agents, approvals, issues } from '@tourbillon/db/schema';
import { buildWakeMessage, buildWakeMessageWithStats } from '@tourbillon/shared';
import {
  loadTour531Fixture,
  tour531Context,
  tour531Job,
  type Tour531Fixture,
} from '../../shared/src/wake-context/__fixtures__/tour-531';
import {
  buildRunWakeMessage,
  buildWakeContext,
  createDrizzleWakeContextRepo,
  type BuildWakeContextInput,
  type WakeApprovalRow,
  type WakeContextRepo,
  type WakeIssueRow,
} from './wake-context';

type Data = {
  issues: WakeIssueRow[];
  approvals: WakeApprovalRow[];
  activity: Array<{ actorType: string; actorId: string; createdAt: string; hasComment: boolean; companyId?: string }>;
  agents?: Array<{ id: string; companyId: string; name: string }>;
};

/** In-memory repo that honours the same company scoping as the drizzle one. */
function memoryRepo(d: Data, calls: string[] = []): WakeContextRepo {
  const co = (companyId: string) => <T extends { companyId: string }>(r: T) => r.companyId === companyId;
  return {
    async getIssue(companyId, id) { calls.push('getIssue'); return d.issues.filter(co(companyId)).find((i) => i.id === id) ?? null; },
    async getIssuesByIds(companyId, ids) { calls.push('getIssuesByIds'); return d.issues.filter(co(companyId)).filter((i) => ids.includes(i.id)); },
    async getIssuesByIdentifiers(companyId, ids) { calls.push('getIssuesByIdentifiers'); return d.issues.filter(co(companyId)).filter((i) => ids.includes(i.identifier)); },
    async getAgentName(companyId, id) { return d.agents?.find((a) => a.companyId === companyId && a.id === id)?.name ?? null; },
    async getLinkedApprovals(companyId, issueId) { return d.approvals.filter(co(companyId)).filter((a) => (a.issueIds ?? []).includes(issueId)); },
    async getApprovalsByIdPrefixes(companyId, prefixes) {
      calls.push(`prefixes:${prefixes.join(',')}`);
      return d.approvals.filter(co(companyId)).filter((a) => prefixes.some((p) => a.id.startsWith(p)));
    },
    async getAgentLastActivityAt(_companyId, agentId, _issueId, before) {
      const xs = d.activity.filter((a) => a.actorType === 'agent' && a.actorId === agentId && Date.parse(a.createdAt) < before.getTime()).map((a) => a.createdAt).sort();
      return xs.length ? new Date(xs[xs.length - 1]) : null;
    },
    async countUserCommentsSince(_companyId, _issueId, since, before) {
      return d.activity.filter((a) => a.actorType === 'user' && a.hasComment && Date.parse(a.createdAt) < before.getTime() && (!since || Date.parse(a.createdAt) > since.getTime())).length;
    },
  };
}

const fixtureRepo = (fx: Tour531Fixture) => memoryRepo({ issues: fx.issues, approvals: fx.approvals, activity: fx.activity });
const fixtureInput = (fx: Tour531Fixture): BuildWakeContextInput => ({
  companyId: fx.companyId,
  agentId: fx.agent.id,
  agentName: fx.agent.name,
  agentUrlKey: fx.agent.urlKey,
  taskId: fx.wake.taskId!,
  wakeReason: 'assignment',
  runStartedAt: new Date(fx.runStartedAt),
  commentBodies: fx.payload.newComments.map((c) => c.body),
});

const CO = 'co-1';
const issue = (over: Partial<WakeIssueRow>): WakeIssueRow => ({
  id: 'task-1', companyId: CO, identifier: 'TOUR-1', title: 'Task', status: 'in_progress', priority: 'high',
  assigneeAgentId: 'agent-1', assigneeUserId: null, parentId: null, blockedByIssueIds: [], ...over,
});
const approval = (id: string, over: Partial<WakeApprovalRow> = {}): WakeApprovalRow => ({
  id, companyId: CO, status: 'approved', note: `note ${id.slice(0, 8)}`, decidedAt: new Date('2026-10-08T07:35:00Z'),
  createdAt: new Date('2026-10-01T00:00:00Z'), issueIds: [], payload: {}, ...over,
});
const input = (bodies: string[], over: Partial<BuildWakeContextInput> = {}): BuildWakeContextInput => ({
  companyId: CO, agentId: 'agent-1', agentName: 'Cyber', agentUrlKey: 'cyber', taskId: 'task-1', wakeReason: 'assignment',
  runStartedAt: new Date('2026-10-08T07:38:00Z'), commentBodies: bodies, ...over,
});
const header = (m: string) => m.slice(m.indexOf('LIVE STATE'), m.indexOf('\n\nRECENT COMMENTS'));
const jobWith = (bodies: string[]) => ({
  agentId: 'agent-1', companyId: CO, invocationSource: 'assignment' as const, wakeReason: 'assignment' as const, taskId: 'task-1',
  wakePayloadJson: JSON.stringify({
    issue: { id: 'task-1', identifier: 'TOUR-1', title: 'Task', status: 'in_progress', priority: 'high', assigneeAgentId: 'agent-1' },
    newComments: bodies.map((body, i) => ({ id: `c${i}`, body, authorType: 'agent', authorName: 'CTO', createdAt: `2026-10-08T0${i}:00:00.000Z` })),
    fallbackFetchNeeded: true,
  }),
});

describe('WC2 buildWakeContext: TOUR-531 fixture', () => {
  it('DB assembly equals the fixture context and renders the spec header', async () => {
    const fx = loadTour531Fixture();
    const ctx = await buildWakeContext(fixtureRepo(fx), fixtureInput(fx));
    assert.ok(ctx);
    const expected = tour531Context(fx);
    // The repo only returns issues cited in the comments; the loader lists all fixture issues.
    const cited = new Set(ctx.referencedIssues.map((i) => i.identifier));
    assert.deepEqual({ ...ctx, referencedIssues: [] }, { ...expected, referencedIssues: [] });
    assert.deepEqual(ctx.referencedIssues, expected.referencedIssues.filter((i) => cited.has(i.identifier)).sort((a, b) => a.identifier.localeCompare(b.identifier)));
    assert.equal(ctx.lastActivityAt, '2026-10-07T21:04:54.158Z');
    assert.equal(ctx.userCommentsSinceLastActivity, 0, 'Board comments after run start are not counted');

    const msg = buildWakeMessage(tour531Job(fx), { context: ctx });
    assert.equal(msg, buildWakeMessage(tour531Job(fx), { context: expected }), 'same message as the fixture context');
    const h = header(msg);
    for (const s of ['23a36ba8 REJECTED', '686ede6c APPROVED', 'Pending among these: none', 'Parent TOUR-540: cancelled', 'Blocked by TOUR-468: blocked']) {
      assert.ok(h.includes(s), s);
    }
    assert.match(h, /Board decisions since your last activity here \(Oct 7 21:04Z\): 9\b/);
  });
});

describe('WC2 buildWakeContext: approvals listed', () => {
  const data = (): Data => ({
    issues: [issue({})],
    approvals: [
      approval('aaaa0001-0000-4000-8000-000000000001', { issueIds: ['task-1'] }), // linked, never cited
      approval('bbbb0002-0000-4000-8000-000000000002'), // cited only
      approval('6ea1e328-ffff-4000-8000-000000000000', { companyId: 'other-co' }), // other company
      approval('cccc0003-0000-4000-8000-000000000003'), // neither
      approval('dddd0004-0000-4000-8000-000000000004'), // ambiguous prefix
      approval('dddd0004-1111-4000-8000-000000000005'),
    ],
    activity: [],
  });
  const bodies = ['Waiting on bbbb0002 and 6ea1e328; also dddd0004; commit 0123abcd4567ef89aa.'];

  it('referenced-only and issue_ids-linked approvals are listed; non-approval, other-company and ambiguous tokens are not', async () => {
    const ctx = await buildWakeContext(memoryRepo(data()), input(bodies));
    assert.ok(ctx);
    assert.deepEqual(ctx.approvals.map((a) => [a.id.slice(0, 8), a.linked]), [['aaaa0001', true], ['bbbb0002', false]]);
    const { message, stats } = buildWakeMessageWithStats(jobWith(bodies), { context: ctx });
    assert.deepEqual([...stats.approvalsListed].sort(), ['aaaa0001', 'bbbb0002']);
    const h = header(message);
    assert.ok(!h.includes('6ea1e328') && !h.includes('cccc0003') && !h.includes('dddd0004'));
  });

  it('a token the repo leaks from another company is still dropped (defence in depth)', async () => {
    const leaky = memoryRepo(data());
    leaky.getApprovalsByIdPrefixes = async () => [approval('6ea1e328-ffff-4000-8000-000000000000', { companyId: 'other-co' })];
    const ctx = await buildWakeContext(leaky, input(bodies));
    assert.ok(ctx && !ctx.approvals.some((a) => a.id.startsWith('6ea1e328')));
  });

  it('only 8-hex tokens from the comments are queried, sorted and capped', async () => {
    const calls: string[] = [];
    await buildWakeContext(memoryRepo(data(), calls), input(bodies));
    assert.ok(calls.includes('prefixes:6ea1e328,bbbb0002,dddd0004'), calls.join(' | '));
  });
});

describe('WC2 buildWakeContext: last activity boundary and empty cases', () => {
  it('an approval decided before the agent\'s last comment is not counted in "since"; later Board comments are', async () => {
    const d: Data = {
      issues: [issue({})],
      approvals: [
        approval('e0000001-0000-4000-8000-000000000001', { issueIds: ['task-1'], decidedAt: new Date('2026-10-07T20:00:00Z') }),
        approval('e0000002-0000-4000-8000-000000000002', { issueIds: ['task-1'], decidedAt: new Date('2026-10-08T07:00:00Z') }),
        approval('e0000003-0000-4000-8000-000000000003', { issueIds: ['task-1'], status: 'pending', decidedAt: null }),
      ],
      activity: [
        { actorType: 'agent', actorId: 'agent-1', createdAt: '2026-10-07T21:00:00.000Z', hasComment: true },
        { actorType: 'agent', actorId: 'agent-2', createdAt: '2026-10-08T06:00:00.000Z', hasComment: true },
        { actorType: 'user', actorId: 'u', createdAt: '2026-10-07T20:30:00.000Z', hasComment: true }, // before
        { actorType: 'user', actorId: 'u', createdAt: '2026-10-08T07:10:00.000Z', hasComment: true }, // counted
        { actorType: 'user', actorId: 'u', createdAt: '2026-10-08T07:20:00.000Z', hasComment: false }, // status only
        { actorType: 'user', actorId: 'u', createdAt: '2026-10-08T07:40:00.000Z', hasComment: true }, // after run start
      ],
    };
    const ctx = await buildWakeContext(memoryRepo(d), input([]));
    assert.ok(ctx);
    assert.equal(ctx.lastActivityAt, '2026-10-07T21:00:00.000Z');
    assert.equal(ctx.userCommentsSinceLastActivity, 1);
    const h = header(buildWakeMessage(jobWith([]), { context: ctx }));
    assert.ok(h.includes('- Board decisions since your last activity here (Oct 7 21:00Z): 2 (1 approval decision listed above, 1 Board/user comment).'), h);
    assert.ok(h.includes('Pending among these: 1.'));
    assert.ok(h.split('\n').find((l) => l.includes('e0000003'))!.includes('PENDING'));
  });

  it('no parent, blockers, approvals or prior activity: header still renders with "none"', async () => {
    const ctx = await buildWakeContext(memoryRepo({ issues: [issue({ assigneeAgentId: null })], approvals: [], activity: [] }), input([]));
    assert.ok(ctx);
    assert.equal(ctx.parent, null);
    assert.deepEqual(ctx.blockers, []);
    assert.equal(ctx.task.assignee.kind, 'none');
    const h = header(buildWakeMessage(jobWith(['a plain note']), { context: ctx }));
    assert.ok(h.includes('- Approvals referenced on this issue: none'));
    assert.ok(h.includes('(none on record): 0.'));
  });

  it('parent and blockers resolve with status; another agent as assignee is named', async () => {
    const ctx = await buildWakeContext(
      memoryRepo({
        issues: [
          issue({ parentId: 'p', blockedByIssueIds: ['b1', 'missing', 'b2'], assigneeAgentId: 'agent-9' }),
          issue({ id: 'p', identifier: 'TOUR-2', status: 'cancelled' }),
          issue({ id: 'b1', identifier: 'TOUR-3', status: 'blocked' }),
          issue({ id: 'b2', identifier: 'TOUR-4', status: 'done', companyId: 'other-co' }),
        ],
        approvals: [],
        activity: [],
        agents: [{ id: 'agent-9', companyId: CO, name: 'CTO' }],
      }),
      input([]),
    );
    assert.ok(ctx);
    assert.deepEqual(ctx.parent, { identifier: 'TOUR-2', status: 'cancelled' });
    assert.deepEqual(ctx.blockers, [{ identifier: 'TOUR-3', status: 'blocked' }]);
    assert.deepEqual(ctx.task.assignee, { kind: 'agent', name: 'CTO' });
  });

  it('no task row (or another company\'s task), no task id, or agent_mail → null', async () => {
    const repo = memoryRepo({ issues: [issue({ companyId: 'other-co' })], approvals: [], activity: [] });
    assert.equal(await buildWakeContext(repo, input([])), null);
    assert.equal(await buildWakeContext(repo, input([], { taskId: '' })), null);
    assert.equal(await buildWakeContext(memoryRepo({ issues: [issue({})], approvals: [], activity: [] }), input([], { wakeReason: 'agent_mail' })), null);
  });

  it('deterministic: same rows and input give the same context', async () => {
    const fx = loadTour531Fixture();
    const a = await buildWakeContext(fixtureRepo(fx), fixtureInput(fx));
    const b = await buildWakeContext(fixtureRepo(loadTour531Fixture()), fixtureInput(fx));
    assert.deepEqual(a, b);
  });
});

describe('WC2/WC6 buildRunWakeMessage (wake-runner)', () => {
  const fx = loadTour531Fixture();
  const base = {
    agentId: fx.agent.id, companyId: fx.companyId, agentName: fx.agent.name, agentUrlKey: fx.agent.urlKey,
    runStartedAt: new Date(fx.runStartedAt),
  };

  it('flag on: v2 message with counts, version and message hash for contextSnapshot.wakeContext', async () => {
    const { wakeMessage, wakeContextSnapshot } = await buildRunWakeMessage(tour531Job(fx), {
      ...base, companySettings: { wakeContextV2: true }, repo: fixtureRepo(fx),
    });
    assert.ok(wakeMessage.includes('LIVE STATE'));
    assert.equal(wakeContextSnapshot.mode, 'v2');
    assert.equal(wakeContextSnapshot.enabled, true);
    assert.equal(wakeContextSnapshot.source, 'company');
    assert.equal(wakeContextSnapshot.version, 1);
    assert.equal(wakeContextSnapshot.totalChars, wakeMessage.length);
    assert.match(wakeContextSnapshot.messageSha256, /^[0-9a-f]{64}$/);
    for (const k of ['headerChars', 'commentChars', 'shown', 'hidden', 'dropped', 'deduped', 'annotated']) {
      assert.equal(typeof wakeContextSnapshot[k], 'number', k);
    }
    assert.equal((wakeContextSnapshot.approvalsListed as string[]).length, 10);
  });

  it('failure path: a repo throw still builds the T1 message and logs wake_context_failed', async () => {
    const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
    const repo = fixtureRepo(fx);
    repo.getLinkedApprovals = async () => { throw new Error('db down'); };
    const { wakeMessage, wakeContextSnapshot } = await buildRunWakeMessage(tour531Job(fx), {
      ...base, companySettings: { wakeContextV2: true }, repo, tracer: { warn: (m, d) => warnings.push([m, d]) },
    });
    assert.equal(wakeContextSnapshot.mode, 't1');
    assert.equal(wakeContextSnapshot.error, 'db down');
    assert.deepEqual(warnings.map((w) => w[0]), ['wake_context_failed']);
    assert.equal(wakeMessage, buildWakeMessage(tour531Job(fx)));
    assert.ok(wakeMessage.includes('Board answered `686ede6c`'), 'T1 keeps the newest comment');
  });

  it('flag off (default): no DB read, T1 message', async () => {
    const saved = process.env.TOURBILLON_WAKE_CONTEXT_V2;
    delete process.env.TOURBILLON_WAKE_CONTEXT_V2;
    try {
      let called = 0;
      const { wakeContextSnapshot } = await buildRunWakeMessage(tour531Job(fx), {
        ...base, companySettings: {},
        repo: () => { throw new Error('repo must not be built when the flag is off'); },
        buildContext: async () => { called++; return null; },
      });
      assert.equal(called, 0);
      assert.equal(wakeContextSnapshot.mode, 't1');
      assert.equal(wakeContextSnapshot.enabled, false);
    } finally {
      if (saved !== undefined) process.env.TOURBILLON_WAKE_CONTEXT_V2 = saved;
    }
  });
});

describe('createDrizzleWakeContextRepo (SQL shape, fake client)', () => {
  function recordingDb() {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      options: { parsers: {}, serializers: {} },
      unsafe(sql: string, params: unknown[]) {
        calls.push({ sql, params });
        const p = Promise.resolve([]) as unknown as Promise<unknown[]> & { values: () => Promise<unknown[]> };
        p.values = () => Promise.resolve([]);
        return p;
      },
    };
    return { db: drizzle(client as never), calls };
  }

  it('every query is scoped by company_id; linked approvals use @>, cited ids use a prefix LIKE', async () => {
    const { db, calls } = recordingDb();
    const repo = createDrizzleWakeContextRepo({ db: db as never, issues, approvals, activityLog, agents });
    const before = new Date('2026-10-08T07:38:00Z');
    await repo.getIssue(CO, 'task-1');
    await repo.getIssuesByIds(CO, ['a', 'b']);
    await repo.getIssuesByIdentifiers(CO, ['TOUR-1']);
    await repo.getAgentName(CO, 'agent-9');
    await repo.getLinkedApprovals(CO, 'task-1');
    await repo.getApprovalsByIdPrefixes(CO, ['23a36ba8', 'not-hex!', '686ede6c']);
    await repo.getAgentLastActivityAt(CO, 'agent-1', 'task-1', before);
    await repo.countUserCommentsSince(CO, 'task-1', new Date('2026-10-07T21:00:00Z'), before);
    assert.equal(calls.length, 8);
    for (const c of calls) {
      assert.match(c.sql, /"company_id" = \$\d+/, c.sql);
      assert.ok(c.params.includes(CO), c.sql);
      assert.match(c.sql, /^select /, 'read-only');
    }
    assert.match(calls[4].sql, /"issue_ids" @> \$\d+/);
    assert.match(calls[5].sql, /"id" like \$\d+ or "approvals"\."id" like \$\d+/);
    assert.ok(calls[5].params.includes('23a36ba8%') && calls[5].params.includes('686ede6c%'));
    assert.ok(!calls[5].params.some((p) => String(p).startsWith('not-hex')));
    assert.match(calls[6].sql, /"actor_type" = \$\d+ and "activity_log"\."actor_id" = \$\d+ and "activity_log"\."created_at" < \$\d+/);
    assert.match(calls[7].sql, /"created_at" > \$\d+/);
  });

  it('no prefixes / no ids → no query', async () => {
    const { db, calls } = recordingDb();
    const repo = createDrizzleWakeContextRepo({ db: db as never, issues, approvals, activityLog, agents });
    assert.deepEqual(await repo.getApprovalsByIdPrefixes(CO, ['nope']), []);
    assert.deepEqual(await repo.getIssuesByIds(CO, []), []);
    assert.equal(calls.length, 0);
  });
});
