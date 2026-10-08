/** Approval details: company isolation, 404 cases, payload redaction and history ordering. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RELATED_APPROVALS_LIMIT,
  buildApprovalHistory,
  relatedApprovalsFor,
  decidedByLabel,
  loadApprovalDetail,
  redactApprovalPayload,
  type ApprovalActivityRow,
  type ApprovalAgentRow,
  type ApprovalDetailRepo,
  type ApprovalIssueRow,
  type ApprovalRow,
} from './approval-detail';

const T = (hhmm: string) => new Date(`2026-10-08T${hhmm}:00.000Z`);

function approval(over: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: 'appr-a',
    companyId: 'company-a',
    type: 'request_board_approval',
    status: 'pending',
    requestedByAgentId: 'agent-a',
    decidedByUserId: null,
    issueIds: ['issue-a1'],
    payload: { title: 'Ship it', summary: 'Please approve' },
    note: null,
    decidedAt: null,
    hitlyApprovalId: null,
    hitlyError: null,
    createdAt: T('09:00'),
    updatedAt: T('09:00'),
    ...over,
  };
}

function activity(over: Partial<ApprovalActivityRow>): ApprovalActivityRow {
  return {
    id: Math.random().toString(36).slice(2),
    companyId: 'company-a',
    actorType: 'agent',
    actorId: 'agent-a',
    actorName: null,
    action: 'issue.updated',
    entityType: 'issue',
    entityId: 'issue-a1',
    details: {},
    createdAt: T('09:00'),
    ...over,
  };
}

interface Store {
  approvals: ApprovalRow[];
  agents: ApprovalAgentRow[];
  issues: ApprovalIssueRow[];
  activity: ApprovalActivityRow[];
  settings: Record<string, unknown>;
}

/**
 * In-memory repo. getApproval deliberately ignores companyId (like an unscoped query would), so
 * the tests prove loadApprovalDetail itself refuses another company's row.
 */
function memoryRepo(s: Store): ApprovalDetailRepo & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getApproval(_companyId, id) {
      calls.push('getApproval');
      return s.approvals.find((a) => a.id === id) ?? null;
    },
    async getAgent(_companyId, id) {
      calls.push('getAgent');
      return s.agents.find((a) => a.id === id) ?? null;
    },
    async getIssues(_companyId, ids) {
      calls.push('getIssues');
      return s.issues.filter((i) => ids.includes(i.id));
    },
    async getActivity() {
      calls.push('getActivity');
      return s.activity;
    },
    async getCompanySettings(companyId) {
      calls.push('getCompanySettings');
      return s.settings[companyId] ?? null;
    },
  };
}

function store(): Store {
  return {
    approvals: [
      approval(),
      approval({ id: 'appr-b', companyId: 'company-b', requestedByAgentId: 'agent-b', issueIds: ['issue-b1'] }),
    ],
    agents: [
      { id: 'agent-a', companyId: 'company-a', name: 'Alice', urlKey: 'alice', runtimeConfig: {} },
      { id: 'agent-b', companyId: 'company-b', name: 'Bob', urlKey: 'bob', runtimeConfig: {} },
    ],
    issues: [
      { id: 'issue-a1', companyId: 'company-a', identifier: 'TOUR-1', title: 'A', status: 'blocked', boardApprovalId: 'appr-a' },
      { id: 'issue-b1', companyId: 'company-b', identifier: 'OTHER-1', title: 'B', status: 'blocked', boardApprovalId: 'appr-b' },
    ],
    activity: [],
    settings: {},
  };
}

describe('approval details: company isolation and 404s', () => {
  it('own company approval loads with requester, linked issues and title', async () => {
    const d = await loadApprovalDetail(memoryRepo(store()), 'company-a', 'appr-a');
    assert.ok(d);
    assert.equal(d.approval.title, 'Ship it');
    assert.equal(d.approval.summary, 'Please approve');
    assert.deepEqual(d.requester, { id: 'agent-a', name: 'Alice', urlKey: 'alice' });
    assert.deepEqual(d.linkedIssues.map((i) => [i.identifier, i.haltedByThis]), [['TOUR-1', true]]);
    assert.equal(d.decidedBy, null);
  });

  it('unknown id → null (404)', async () => {
    assert.equal(await loadApprovalDetail(memoryRepo(store()), 'company-a', 'nope'), null);
    assert.equal(await loadApprovalDetail(memoryRepo(store()), 'company-a', ''), null);
  });

  it("another company's id → null (404), and nothing else about it is read", async () => {
    const repo = memoryRepo(store());
    assert.equal(await loadApprovalDetail(repo, 'company-a', 'appr-b'), null);
    assert.deepEqual(repo.calls, ['getApproval']);
  });

  it("another company's issues and agent never appear, even if a row links them", async () => {
    const s = store();
    s.approvals[0] = approval({ requestedByAgentId: 'agent-b', issueIds: ['issue-a1', 'issue-b1'] });
    const d = await loadApprovalDetail(memoryRepo(s), 'company-a', 'appr-a');
    assert.ok(d);
    assert.equal(d.requester, null);
    assert.deepEqual(d.linkedIssues.map((i) => i.identifier), ['TOUR-1']);
    assert.deepEqual(d.missingIssueIds, ['issue-b1']);
    assert.ok(!JSON.stringify(d).includes('OTHER-1'));
    assert.ok(!JSON.stringify(d).includes('Bob'));
  });

  it("another company's activity rows are ignored", async () => {
    const s = store();
    s.activity = [activity({ companyId: 'company-b', details: { boardApprovalId: 'appr-a' }, actorName: 'Mallory' })];
    const d = await loadApprovalDetail(memoryRepo(s), 'company-a', 'appr-a');
    assert.ok(d);
    assert.deepEqual(d.history.map((e) => e.kind), ['created']);
  });
});

describe('approval details: payload redaction', () => {
  it('redacts the HITLy resume token, runtimeConfig secrets and known secret values', () => {
    const out = redactApprovalPayload(
      {
        title: 'Hire',
        hitlyResumeToken: 'resume-token-abcdefghijkl',
        agent: { runtimeConfig: { secrets: { GH_TOKEN: 'ghp_supersecretvalue1' }, tavilyApiKey: 'tvly-123456789' } },
        notes: 'uses key hitly-api-key-0123456789 inline',
        priorStatuses: { 'issue-a1': 'todo' },
      },
      [{ hitlyGate: { apiKey: 'hitly-api-key-0123456789' } }, null],
    ) as Record<string, unknown>;
    const text = JSON.stringify(out);
    for (const leak of ['resume-token-abcdefghijkl', 'ghp_supersecretvalue1', 'tvly-123456789', 'hitly-api-key-0123456789']) {
      assert.ok(!text.includes(leak), leak);
    }
    assert.equal(out.hitlyResumeToken, '[redacted]');
    assert.equal(out.title, 'Hire');
    assert.deepEqual(out.priorStatuses, { 'issue-a1': 'todo' });
    assert.match(String(out.notes), /\[REDACTED:hitlyGate\.apiKey\]/);
  });

  it('the loader returns the redacted payload', async () => {
    const s = store();
    s.approvals[0] = approval({ payload: { title: 'X', hitlyResumeToken: 'resume-token-abcdefghijkl' } });
    const d = await loadApprovalDetail(memoryRepo(s), 'company-a', 'appr-a');
    assert.ok(!JSON.stringify(d).includes('resume-token-abcdefghijkl'));
  });
});

describe('approval details: history ordering', () => {
  it('chronological, oldest first, whatever order the rows arrive in', () => {
    const a = approval({ status: 'approved', decidedAt: T('10:30'), note: 'Go ahead.\nSecond line.' });
    const rows = [
      activity({ createdAt: T('10:30'), actorType: 'system', actorId: 'board', actorName: 'Board', details: { approvalId: 'appr-a', decision: 'approved', status: 'todo' } }),
      activity({ createdAt: T('09:00'), details: { boardApprovalId: 'appr-a', status: 'blocked', priorStatus: 'in_progress' } }),
      activity({ createdAt: T('09:45'), entityType: 'approval', entityId: 'appr-a', action: 'approval.commented', actorName: 'Board', details: { note: 'Need numbers' } }),
    ];
    const h = buildApprovalHistory(a, rows, {
      requesterName: 'Alice',
      issuesById: new Map([['issue-a1', { id: 'issue-a1', identifier: 'TOUR-1' }]]),
    });
    assert.deepEqual(
      h.map((e) => [e.kind, e.at?.toISOString().slice(11, 16)]),
      [
        ['created', '09:00'],
        ['issue_halted', '09:00'],
        ['activity', '09:45'],
        ['decided', '10:30'],
        ['issue_released', '10:30'],
      ],
    );
    assert.equal(h[0].actor, 'Alice');
    assert.equal(h[1].text, 'TOUR-1 halted (blocked, was in_progress)');
    assert.equal(h[1].actor, 'Alice');
    assert.equal(h[3].text, 'Approved');
    assert.equal(h[3].actor, 'Board');
    assert.equal(h[3].note, 'Go ahead.\nSecond line.');
    assert.equal(h[4].text, 'TOUR-1 → todo after approved');
    for (let i = 1; i < h.length; i++) {
      assert.ok((h[i].at ?? a.createdAt) >= (h[i - 1].at ?? a.createdAt), `event ${i} not before ${i - 1}`);
    }
  });

  it('untimed HITLy hand-off sits right after creation; a pending approval has no decision event', () => {
    const a = approval({ hitlyApprovalId: 'hitly-1', hitlyError: 'timeout' });
    const h = buildApprovalHistory(a, [activity({ createdAt: T('09:01'), details: { boardApprovalId: 'appr-a' } })]);
    assert.deepEqual(h.map((e) => e.kind), ['created', 'hitly_sent', 'hitly_error', 'issue_halted']);
  });

  it('ties on time keep input order within the same kind; unrelated rows are dropped', () => {
    const a = approval();
    const h = buildApprovalHistory(a, [
      activity({ createdAt: T('09:05'), entityId: 'issue-2', details: { boardApprovalId: 'appr-a' } }),
      activity({ createdAt: T('09:05'), entityId: 'issue-1', details: { boardApprovalId: 'appr-a' } }),
      activity({ createdAt: T('09:06'), details: { boardApprovalId: 'other-approval' } }),
      activity({ createdAt: T('09:07'), entityType: 'approval', entityId: 'other-approval', action: 'approval.commented' }),
    ]);
    assert.deepEqual(h.map((e) => e.issue?.id ?? e.kind), ['created', 'issue-2', 'issue-1']);
  });

  it('approval.created / approval.decided rows replace the row-derived events (actor + note), never twice', () => {
    const a = approval({ status: 'rejected', decidedAt: T('11:00'), note: 'row note', decidedByUserId: null });
    const h = buildApprovalHistory(
      a,
      [
        activity({ createdAt: T('11:00'), entityType: 'approval', entityId: 'appr-a', action: 'approval.decided', actorType: 'user', actorId: 'mcp', actorName: 'Board (via MCP)', details: { decision: 'rejected', note: 'Too costly' } }),
        activity({ createdAt: T('09:00'), entityType: 'approval', entityId: 'appr-a', action: 'approval.created', actorName: 'Alice', details: { note: 'Please ship' } }),
        // a stray second decided row (should never be written) is not shown twice
        activity({ createdAt: T('11:01'), entityType: 'approval', entityId: 'appr-a', action: 'approval.decided', actorName: 'Board', details: { decision: 'approved' } }),
      ],
      { requesterName: 'Alice' },
    );
    assert.deepEqual(h.map((e) => [e.kind, e.source, e.actor, e.text, e.note]), [
      ['created', 'activity_log', 'Alice', 'Requested (request_board_approval)', 'Please ship'],
      ['decided', 'activity_log', 'Board (via MCP)', 'Rejected', 'Too costly'],
    ]);
  });

  it('older approvals without lifecycle rows keep the row-derived created/decided events', () => {
    const a = approval({ status: 'approved', decidedAt: T('10:00'), note: 'ok', decidedByUserId: 'hitly' });
    const h = buildApprovalHistory(a, [], { requesterName: 'Alice' });
    assert.deepEqual(h.map((e) => [e.kind, e.source, e.actor, e.note]), [
      ['created', 'approvals', 'Alice', undefined],
      ['decided', 'approvals', 'HITLy', 'ok'],
    ]);
  });

  it('only one of the two lifecycle rows present: the other event falls back to the approvals row', () => {
    const a = approval({ status: 'approved', decidedAt: T('10:00'), note: 'ok' });
    const h = buildApprovalHistory(a, [
      activity({ createdAt: T('10:00'), entityType: 'approval', entityId: 'appr-a', action: 'approval.decided', actorName: 'Board', details: { decision: 'approved', note: 'ok' } }),
    ]);
    assert.deepEqual(h.map((e) => [e.kind, e.source]), [['created', 'approvals'], ['decided', 'activity_log']]);
  });

  it("another company's or another approval's lifecycle rows are ignored", () => {
    const a = approval();
    const h = buildApprovalHistory(a, [
      activity({ companyId: 'company-b', createdAt: T('09:30'), entityType: 'approval', entityId: 'appr-a', action: 'approval.decided', actorName: 'Mallory', details: { decision: 'approved' } }),
      activity({ createdAt: T('09:30'), entityType: 'approval', entityId: 'appr-z', action: 'approval.created', actorName: 'Zed' }),
    ]);
    assert.deepEqual(h.map((e) => [e.kind, e.source]), [['created', 'approvals']]);
  });

  it('history ordering with lifecycle rows, halts and releases interleaved', () => {
    const a = approval({ status: 'approved', decidedAt: T('10:30') });
    const h = buildApprovalHistory(a, [
      activity({ createdAt: T('10:30'), actorName: 'Board', details: { approvalId: 'appr-a', decision: 'approved', status: 'todo' } }),
      activity({ createdAt: T('10:30'), entityType: 'approval', entityId: 'appr-a', action: 'approval.decided', actorName: 'Board', details: { decision: 'approved' } }),
      activity({ createdAt: T('09:00'), details: { boardApprovalId: 'appr-a', status: 'blocked' } }),
      activity({ createdAt: T('09:00'), entityType: 'approval', entityId: 'appr-a', action: 'approval.created', actorName: 'Alice' }),
    ]);
    assert.deepEqual(h.map((e) => e.kind), ['created', 'issue_halted', 'decided', 'issue_released']);
  });

  it("a rejection reason is labelled 'Board feedback' (row-derived and activity-row events); approval notes are 'Note'", () => {
    const rejected = buildApprovalHistory(approval({ status: 'rejected', decidedAt: T('10:00'), note: 'Split it up' }), []);
    assert.deepEqual([rejected[1].text, rejected[1].note, rejected[1].noteLabel], ['Rejected', 'Split it up', 'Board feedback']);
    const fromRow = buildApprovalHistory(approval({ status: 'rejected', decidedAt: T('10:00') }), [
      activity({ createdAt: T('10:00'), entityType: 'approval', entityId: 'appr-a', action: 'approval.decided', actorName: 'Board', details: { decision: 'rejected', note: 'Add tests' } }),
    ]);
    assert.equal(fromRow[1].noteLabel, 'Board feedback');
    const approved = buildApprovalHistory(approval({ status: 'approved', decidedAt: T('10:00'), note: 'ok' }), []);
    assert.equal(approved[1].noteLabel, 'Note');
    const noNote = buildApprovalHistory(approval({ status: 'rejected', decidedAt: T('10:00') }), []);
    assert.equal(noNote[1].noteLabel, undefined);
  });

  it('decided-by labels', () => {
    assert.equal(decidedByLabel({ status: 'pending', decidedByUserId: null }), null);
    assert.equal(decidedByLabel({ status: 'approved', decidedByUserId: null }), 'Board');
    assert.equal(decidedByLabel({ status: 'approved', decidedByUserId: 'hitly' }), 'HITLy');
    assert.equal(decidedByLabel({ status: 'rejected', decidedByUserId: 'mcp' }), 'Board (via MCP)');
  });
});

describe('approval details: related approvals on the same issues', () => {
  const rel = (id: string, over: Partial<ApprovalRow> = {}) =>
    approval({ id, issueIds: ['issue-a1'], payload: { title: `t-${id}` }, ...over });

  it('same company, shares a linked issue, not itself; newest first', () => {
    const me = approval({ issueIds: ['issue-a1', 'issue-a2'] });
    const out = relatedApprovalsFor(me, [
      rel('old', { createdAt: T('08:00'), status: 'rejected' }),
      rel('appr-a'), // itself
      rel('other-co', { companyId: 'company-b', createdAt: T('11:00') }),
      rel('no-overlap', { issueIds: ['issue-zz'], createdAt: T('11:30') }),
      rel('new', { createdAt: T('10:00'), issueIds: ['issue-a2', 'issue-x'] }),
      rel('new'), // duplicate row
    ]);
    assert.deepEqual(out.map((r) => [r.id, r.title, r.status, r.sharedIssueIds]), [
      ['new', 't-new', 'pending', ['issue-a2']],
      ['old', 't-old', 'rejected', ['issue-a1']],
    ]);
  });

  it(`capped at ${RELATED_APPROVALS_LIMIT}`, () => {
    const rows = Array.from({ length: 30 }, (_, i) => rel(`r${i}`, { createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)) }));
    const out = relatedApprovalsFor(approval(), rows);
    assert.equal(out.length, RELATED_APPROVALS_LIMIT);
    assert.equal(out[0].id, 'r29');
  });

  it('loader: related approvals are company-scoped even if the repo returns other companies; none without linked issues', async () => {
    const s = store();
    s.approvals.push(
      approval({ id: 'appr-a-old', issueIds: ['issue-a1'], status: 'rejected', createdAt: T('08:00'), payload: { title: 'First try' } }),
      approval({ id: 'appr-b-x', companyId: 'company-b', issueIds: ['issue-a1'], payload: { title: 'B secret' } }),
    );
    const repo = { ...memoryRepo(s), getRelatedApprovals: async () => s.approvals };
    const d = await loadApprovalDetail(repo, 'company-a', 'appr-a');
    assert.ok(d);
    assert.deepEqual(d.relatedApprovals.map((r) => [r.id, r.title, r.status]), [['appr-a-old', 'First try', 'rejected']]);
    assert.ok(!JSON.stringify(d).includes('B secret'));

    s.approvals[0] = approval({ issueIds: [] });
    let called = false;
    const d2 = await loadApprovalDetail({ ...memoryRepo(s), getRelatedApprovals: async () => ((called = true), s.approvals) }, 'company-a', 'appr-a');
    assert.deepEqual(d2?.relatedApprovals, []);
    assert.equal(called, false);
  });
});
