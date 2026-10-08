/** Approval details: company isolation, 404 cases, redaction of every field and history ordering. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalDetailJson,
  buildApprovalHistory,
  decidedByLabel,
  isValidApprovalId,
  loadApprovalDetail,
  loadApprovalRedactor,
  type ApprovalActivityRow,
  type ApprovalAgentRow,
  type ApprovalDetailRepo,
  type ApprovalIssueRow,
  type ApprovalRow,
} from './approval-detail';
import { PLANTED_VALUES, plantedRepo } from './approval-detail-secrets.fixture';
import { REDACTION_UNAVAILABLE } from './approval-redaction';

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
  secretValues?: string[];
  vaultUnavailable?: boolean;
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
    async getSecretValues() {
      calls.push('getSecretValues');
      return { values: s.secretValues ?? [], vaultUnavailable: s.vaultUnavailable ?? false };
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

describe('approval details: redaction of every field (#130 B1/B2)', () => {
  it('no planted secret survives anywhere in the loader output or the JSON body', async () => {
    const d = await loadApprovalDetail(plantedRepo(), 'company-a', 'appr-a');
    assert.ok(d);
    const text = JSON.stringify(approvalDetailJson(d));
    const leaked = PLANTED_VALUES.filter((v) => text.includes(v) || text.includes(encodeURIComponent(v)));
    assert.deepEqual(leaked, []);
  });

  it('each field is scrubbed but still readable', async () => {
    const d = await loadApprovalDetail(plantedRepo(), 'company-a', 'appr-a');
    assert.ok(d);
    const payload = d.approval.payload as Record<string, any>;
    assert.equal(d.approval.title, 'Deploy with [redacted]');
    assert.equal(d.approval.summary, 'Call it with Authorization: Bearer [redacted]');
    assert.equal(payload.token, '[redacted]');
    assert.equal(payload.list[0].apiKey, '[redacted]');
    assert.equal(payload.list[1].deeper[0].Cookie, '[redacted]');
    assert.deepEqual(payload.auth, { password: '[redacted]', nested: { secret: '[redacted]' } });
    assert.equal(payload.resumeToken, '[redacted]');
    assert.equal(payload.hitlyResumeToken, '[redacted]');
    assert.deepEqual(payload.headers, { 'x-api-key': '[redacted]', Authorization: '[redacted]' });
    assert.equal(payload.callback, 'https://hooks.example.test/resume');
    assert.equal(payload.notes, 'vault [redacted], provider [redacted], runtime [redacted], settings [redacted]');
    assert.deepEqual(payload.priorStatuses, { 'issue-a1': 'todo' });
    assert.equal(d.approval.note, 'Rejected: see https://ci.example.test/run');
    assert.equal(d.approval.hitlyError, '401 for resume token [redacted] (apiKey=[redacted])');
    assert.equal(d.linkedIssues[0].title, 'Rotate [redacted]');
    const comment = d.history.find((e) => e.text === 'approval.commented');
    assert.equal(comment?.note, 'password was [redacted]; vault [redacted]');
    assert.equal(comment?.actor, 'Board via [redacted]');
    assert.ok(d.history.some((e) => e.text === 'HITLy error: 401 for resume token [redacted] (apiKey=[redacted])'));
    assert.equal(d.approval.payloadTruncated, false);
  });

  it('secret values are loaded once, company-scoped, and never returned as such', async () => {
    const s = store();
    s.secretValues = ['vault-value-abcdefgh'];
    s.approvals[0] = approval({ payload: { title: 'Use vault-value-abcdefgh' } });
    const repo = memoryRepo(s);
    const d = await loadApprovalDetail(repo, 'company-a', 'appr-a');
    assert.equal(d?.approval.title, 'Use [redacted]');
    assert.equal(repo.calls.filter((c) => c === 'getSecretValues').length, 1);
    assert.ok(!JSON.stringify(d).includes('vault-value-abcdefgh'));
  });

  it('a 1,500-deep payload is cut for display (Test S1) and flagged', async () => {
    let deep: unknown = { leaf: 1 };
    for (let i = 0; i < 1500; i++) deep = { n: deep };
    const s = store();
    s.approvals[0] = approval({ payload: { title: 'Deep', deep } });
    const d = await loadApprovalDetail(memoryRepo(s), 'company-a', 'appr-a');
    assert.ok(d);
    assert.equal(d.approval.payloadTruncated, true);
    const json = JSON.stringify(approvalDetailJson(d), null, 2);
    assert.ok(json.length < 5_000, `${json.length}`);
    assert.match(json, /\[truncated: nested deeper than 12 levels\]/);
  });

  it('title and summary are capped', async () => {
    const s = store();
    s.approvals[0] = approval({ payload: { title: 't'.repeat(5_000), summary: 's'.repeat(50_000) } });
    const d = await loadApprovalDetail(memoryRepo(s), 'company-a', 'appr-a');
    assert.equal(d?.approval.title.length, 301);
    assert.equal(d?.approval.summary?.length, 2_001);
  });
});

describe('approval details: malformed ids (Test S3)', () => {
  it('NUL/control characters, empty and >128 chars are invalid; the repo is never asked', async () => {
    for (const bad of ['appr\u0000a', '\u0000', 'a\nb', 'a\u007fb', '', 'x'.repeat(129)]) {
      assert.equal(isValidApprovalId(bad), false, JSON.stringify(bad));
      const repo = memoryRepo(store());
      assert.equal(await loadApprovalDetail(repo, 'company-a', bad), null);
      assert.deepEqual(repo.calls, []);
    }
    for (const ok of ['appr-a', 'clx0123abc', '..', 'x'.repeat(128), 'ü✓']) assert.equal(isValidApprovalId(ok), true, ok);
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

  it('approval.created / approval.decided activity rows do not duplicate the row events', () => {
    const a = approval({ status: 'rejected', decidedAt: T('11:00') });
    const h = buildApprovalHistory(a, [
      activity({ createdAt: T('09:00'), entityType: 'approval', entityId: 'appr-a', action: 'approval.created' }),
      activity({ createdAt: T('11:00'), entityType: 'approval', entityId: 'appr-a', action: 'approval.decided' }),
    ]);
    assert.deepEqual(h.map((e) => e.kind), ['created', 'decided']);
    assert.equal(h[1].text, 'Rejected');
  });

  it('decided-by labels', () => {
    assert.equal(decidedByLabel({ status: 'pending', decidedByUserId: null }), null);
    assert.equal(decidedByLabel({ status: 'approved', decidedByUserId: null }), 'Board');
    assert.equal(decidedByLabel({ status: 'approved', decidedByUserId: 'hitly' }), 'HITLy');
    assert.equal(decidedByLabel({ status: 'rejected', decidedByUserId: 'mcp' }), 'Board (via MCP)');
  });
});

describe('approval details: shared redactor loader for other approval surfaces (Test S15)', () => {
  const repo = (over: Partial<Pick<ApprovalDetailRepo, 'getSecretValues' | 'getCompanySettings'>> = {}) => ({
    getSecretValues: async () => ({ values: ['vault-value-s15-0001'], vaultUnavailable: false }),
    getCompanySettings: async () => ({ hitlyGate: { apiKey: 'settings-value-s15-0002' } }),
    ...over,
  });

  it('scrubs company-wide values plus the requester and payload sources', async () => {
    const r = await loadApprovalRedactor(repo(), 'company-a', {
      requesterRuntimeConfig: { secrets: { GH_TOKEN: 'runtime-value-s15-0003' } },
      payloads: [{ hitlyResumeToken: 'resume-value-s15-0004' }],
    });
    assert.equal(r.unavailable, false);
    assert.equal(
      r.freeText('vault-value-s15-0001 settings-value-s15-0002 runtime-value-s15-0003 resume-value-s15-0004'),
      '[redacted] [redacted] [redacted] [redacted]',
    );
  });

  it('a throwing secret-value load hides free text instead of failing', async () => {
    const r = await loadApprovalRedactor(repo({ getSecretValues: async () => { throw new Error('db down'); } }), 'company-a');
    assert.equal(r.unavailable, true);
    assert.equal(r.freeText('anything'), REDACTION_UNAVAILABLE);
    const sync = await loadApprovalRedactor(repo({ getSecretValues: () => { throw new Error('sync'); } }), 'company-a');
    assert.equal(sync.unavailable, true);
  });

  it('a throwing settings load also hides free text; vault-unavailable carries through', async () => {
    const r = await loadApprovalRedactor(repo({ getCompanySettings: async () => { throw new Error('db down'); } }), 'company-a');
    assert.equal(r.unavailable, true);
    const v = await loadApprovalRedactor(repo({ getSecretValues: async () => ({ values: [], vaultUnavailable: true }) }), 'company-a');
    assert.equal(v.freeText('x'), REDACTION_UNAVAILABLE);
  });

  it('the details loader hides free text when settings fail to load (same helper)', async () => {
    const s = store();
    const base = memoryRepo(s);
    const d = await loadApprovalDetail({ ...base, getCompanySettings: async () => { throw new Error('x'); } }, 'company-a', 'appr-a');
    assert.ok(d);
    assert.equal(d.redactionUnavailable, true);
    assert.equal(d.approval.title, REDACTION_UNAVAILABLE);
  });
});
