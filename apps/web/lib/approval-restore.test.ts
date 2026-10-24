import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FINISHED_ISSUE_STATUSES,
  dependencyIdsOf,
  formatApprovalDecisionComment,
  formatWakeFailedComment,
  formatWakeSkippedComment,
  isUnfinishedIssueStatus,
  planApprovalRestore,
  planApprovalWakes,
  resolveRestoreStatus,
  wakeSkipReasonFromAgentStatus,
  wakeSkipReasonFromScheduler,
  type LinkedIssueForRestore,
} from './approval-restore';

const issue = (over: Partial<LinkedIssueForRestore> = {}): LinkedIssueForRestore => ({
  id: 'i1',
  identifier: 'TB-1',
  status: 'blocked',
  boardApprovalId: 'ap1',
  blockedByIssueIds: [],
  assigneeAgentId: null,
  ...over,
});

describe('APR-FIX resolveRestoreStatus', () => {
  it('saved blocked + approved with no unfinished dependency → todo', () => {
    assert.equal(
      resolveRestoreStatus({ decision: 'approved', priorStatus: 'blocked', currentStatus: 'blocked', unfinishedBlockerCount: 0 }),
      'todo',
    );
  });
  it('saved blocked + approved with an unfinished dependency → stays blocked', () => {
    assert.equal(
      resolveRestoreStatus({ decision: 'approved', priorStatus: 'blocked', currentStatus: 'blocked', unfinishedBlockerCount: 1 }),
      'blocked',
    );
  });
  it('saved non-blocked status comes back as-is', () => {
    for (const prior of ['backlog', 'todo', 'in_progress', 'in_review'] as const) {
      assert.equal(
        resolveRestoreStatus({ decision: 'approved', priorStatus: prior, currentStatus: 'blocked', unfinishedBlockerCount: 0 }),
        prior,
      );
    }
  });
  it('unfinished dependencies keep it blocked whatever was saved (including in_progress)', () => {
    for (const prior of ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', undefined] as const) {
      assert.equal(
        resolveRestoreStatus({ decision: 'approved', priorStatus: prior, currentStatus: 'blocked', unfinishedBlockerCount: 1 }),
        'blocked',
        String(prior),
      );
    }
  });
  it('an issue already done or cancelled keeps its status on either decision', () => {
    for (const current of ['done', 'cancelled'] as const) {
      for (const decision of ['approved', 'rejected'] as const) {
        for (const prior of ['blocked', 'todo', 'in_progress', undefined]) {
          for (const n of [0, 2]) {
            assert.equal(
              resolveRestoreStatus({ decision, priorStatus: prior, currentStatus: current, unfinishedBlockerCount: n }),
              current,
              `${current}/${decision}/${prior}/${n}`,
            );
          }
        }
      }
    }
  });
  it('nothing saved: current blocked → todo (or blocked with dependencies); other current kept', () => {
    assert.equal(resolveRestoreStatus({ decision: 'approved', priorStatus: undefined, currentStatus: 'blocked', unfinishedBlockerCount: 0 }), 'todo');
    assert.equal(resolveRestoreStatus({ decision: 'approved', priorStatus: undefined, currentStatus: 'blocked', unfinishedBlockerCount: 2 }), 'blocked');
    assert.equal(resolveRestoreStatus({ decision: 'approved', priorStatus: undefined, currentStatus: 'in_review', unfinishedBlockerCount: 0 }), 'in_review');
  });
  it('an unknown saved value is ignored', () => {
    assert.equal(resolveRestoreStatus({ decision: 'approved', priorStatus: 'nonsense', currentStatus: 'blocked', unfinishedBlockerCount: 0 }), 'todo');
    assert.equal(resolveRestoreStatus({ decision: 'approved', priorStatus: 42, currentStatus: 'blocked', unfinishedBlockerCount: 0 }), 'todo');
  });
  it('rejected → blocked whatever was saved', () => {
    assert.equal(resolveRestoreStatus({ decision: 'rejected', priorStatus: 'todo', currentStatus: 'blocked', unfinishedBlockerCount: 0 }), 'blocked');
  });
});

describe('APR-FIX unfinished dependency definition', () => {
  it('done and cancelled are finished; everything else is unfinished', () => {
    assert.deepEqual([...FINISHED_ISSUE_STATUSES], ['done', 'cancelled']);
    for (const s of ['done', 'cancelled']) assert.equal(isUnfinishedIssueStatus(s), false, s);
    for (const s of ['backlog', 'todo', 'in_progress', 'in_review', 'blocked']) assert.equal(isUnfinishedIssueStatus(s), true, s);
  });
  it('dependencyIdsOf dedupes and drops self references and blanks', () => {
    assert.deepEqual(
      dependencyIdsOf([issue({ blockedByIssueIds: ['d1', 'i1', '', 'd1'] }), issue({ id: 'i2', blockedByIssueIds: ['d2', 'd1'] })]),
      ['d1', 'd2'],
    );
  });
});

describe('APR-FIX planApprovalRestore', () => {
  const plan = (linked: LinkedIssueForRestore[], deps: Array<{ id: string; identifier: string; status: any }>, priorStatuses: Record<string, unknown> = {}, decision: 'approved' | 'rejected' = 'approved') =>
    planApprovalRestore({ approvalId: 'ap1', decision, priorStatuses, linked, dependencies: deps });

  it('already blocked, then approval, then approved → todo', () => {
    const [o] = plan([issue()], [], { i1: 'blocked' });
    assert.equal(o.restored, true);
    assert.equal(o.status, 'todo');
    assert.deepEqual(o.remainingBlockers, []);
  });
  it('unfinished dependency keeps it blocked and names it', () => {
    const [o] = plan([issue({ blockedByIssueIds: ['d1', 'd2'] })], [
      { id: 'd1', identifier: 'TB-7', status: 'in_progress' },
      { id: 'd2', identifier: 'TB-8', status: 'done' },
    ], { i1: 'blocked' });
    assert.equal(o.status, 'blocked');
    assert.deepEqual(o.remainingBlockers, [{ id: 'd1', identifier: 'TB-7' }]);
  });
  it('dependencies all done/cancelled → todo', () => {
    const [o] = plan([issue({ blockedByIssueIds: ['d1', 'd2'] })], [
      { id: 'd1', identifier: 'TB-7', status: 'cancelled' },
      { id: 'd2', identifier: 'TB-8', status: 'done' },
    ], { i1: 'blocked' });
    assert.equal(o.status, 'todo');
  });
  it('a dependency id not found in the company is ignored', () => {
    const [o] = plan([issue({ blockedByIssueIds: ['other-company'] })], [], { i1: 'blocked' });
    assert.equal(o.status, 'todo');
  });
  it('issue held by another approval is left untouched', () => {
    const [o] = plan([issue({ boardApprovalId: 'ap2', status: 'blocked' })], [], { i1: 'todo' });
    assert.equal(o.restored, false);
    assert.equal(o.status, 'blocked');
  });
  it('saved in_progress with an unfinished dependency stays blocked and names it', () => {
    const [o] = plan([issue({ blockedByIssueIds: ['d1'] })], [{ id: 'd1', identifier: 'TB-7', status: 'todo' }], { i1: 'in_progress' });
    assert.equal(o.status, 'blocked');
    assert.deepEqual(o.remainingBlockers, [{ id: 'd1', identifier: 'TB-7' }]);
    assert.equal(o.alreadyClosed, false);
  });
  it('already done/cancelled: halt cleared, status kept, no blockers reported', () => {
    for (const status of ['done', 'cancelled'] as const) {
      const [o] = plan([issue({ status, blockedByIssueIds: ['d1'] })], [{ id: 'd1', identifier: 'TB-7', status: 'todo' }], { i1: 'blocked' });
      assert.equal(o.restored, true);
      assert.equal(o.status, status);
      assert.equal(o.alreadyClosed, true);
      assert.deepEqual(o.remainingBlockers, [], 'a closed issue never cites blockers');
    }
  });
  it('rejected keeps blocked and reports no blockers', () => {
    const [o] = plan([issue({ blockedByIssueIds: ['d1'] })], [{ id: 'd1', identifier: 'TB-7', status: 'todo' }], { i1: 'todo' }, 'rejected');
    assert.equal(o.status, 'blocked');
    assert.deepEqual(o.remainingBlockers, []);
  });
});

describe('APR-FIX formatApprovalDecisionComment', () => {
  const base = { source: 'Board', title: 'Ship it', note: null };
  it('states the new status instead of a fixed "unhalted" line', () => {
    const body = formatApprovalDecisionComment({
      ...base,
      decision: 'approved',
      outcome: { issueId: 'i1', identifier: 'TB-1', restored: true, status: 'todo', remainingBlockers: [], assigneeAgentId: null },
    });
    assert.match(body, /^\*\*Board Approved:\*\* Ship it/);
    assert.match(body, /Status restored to todo\./);
    assert.doesNotMatch(body, /unhalted/);
  });
  it('names the remaining blockers by key', () => {
    const body = formatApprovalDecisionComment({
      ...base,
      decision: 'approved',
      outcome: {
        issueId: 'i1', identifier: 'TB-1', restored: true, status: 'blocked', assigneeAgentId: null,
        remainingBlockers: [{ id: 'd1', identifier: 'TB-7' }, { id: 'd2', identifier: null }],
      },
    });
    assert.match(body, /Still blocked by TB-7, d2 \(unfinished dependencies\)/);
  });
  it('restored to a non-blocked status: no blocker wording', () => {
    for (const status of ['todo', 'in_progress', 'in_review', 'backlog'] as const) {
      const body = formatApprovalDecisionComment({
        ...base,
        decision: 'approved',
        outcome: { issueId: 'i1', identifier: 'TB-1', restored: true, status, remainingBlockers: [], assigneeAgentId: null },
      });
      assert.ok(body.endsWith(`Status restored to ${status}. Continue work if still assigned.`), body);
      assert.doesNotMatch(body, /Still blocked/);
    }
  });
  it('already closed: says the status is unchanged, on either decision', () => {
    for (const decision of ['approved', 'rejected'] as const) {
      const body = formatApprovalDecisionComment({
        ...base,
        decision,
        outcome: { issueId: 'i1', identifier: 'TB-1', restored: true, status: 'done', remainingBlockers: [], assigneeAgentId: null, alreadyClosed: true },
      });
      assert.match(body, /Status unchanged \(done\): this issue was already closed\./);
      assert.doesNotMatch(body, /remains blocked|restored to/);
    }
  });
  it('held by another approval / rejected wording', () => {
    assert.match(
      formatApprovalDecisionComment({ ...base, decision: 'approved', outcome: { issueId: 'i1', identifier: 'TB-1', restored: false, status: 'blocked', remainingBlockers: [], assigneeAgentId: null } }),
      /held by another approval/,
    );
    assert.match(formatApprovalDecisionComment({ ...base, note: 'n', decision: 'rejected', outcome: undefined }), /Note: n\nThis issue remains blocked/);
  });
});

describe('APR-FIX planApprovalWakes', () => {
  const o = (issueId: string, assigneeAgentId: string | null, status: any = 'todo', restored = true) =>
    ({ issueId, identifier: null, restored, status, remainingBlockers: [], assigneeAgentId });

  it('wakes the requester and each assignee of an unblocked issue', () => {
    assert.deepEqual(
      planApprovalWakes({ decision: 'approved', requesterAgentId: 'req', issueIds: ['i1', 'i2', 'i3'], outcomes: [o('i1', 'a1'), o('i2', 'a1'), o('i3', 'a2')] }),
      [
        { agentId: 'req', role: 'requester', issueIds: ['i1', 'i2', 'i3'] },
        { agentId: 'a1', role: 'assignee', issueIds: ['i1', 'i2'] },
        { agentId: 'a2', role: 'assignee', issueIds: ['i3'] },
      ],
    );
  });
  it('dedupes an assignee who is also the requester', () => {
    assert.deepEqual(
      planApprovalWakes({ decision: 'approved', requesterAgentId: 'req', issueIds: ['i1'], outcomes: [o('i1', 'req')] }),
      [{ agentId: 'req', role: 'requester', issueIds: ['i1'] }],
    );
  });
  it('no assignee wake for an issue that was already closed', () => {
    const closed = { ...o('i1', 'a1', 'done'), alreadyClosed: true };
    assert.deepEqual(planApprovalWakes({ decision: 'approved', requesterAgentId: null, issueIds: ['i1'], outcomes: [closed] }), []);
  });
  it('no assignee wake for still-blocked, untouched, or rejected issues', () => {
    const outcomes = [o('i1', 'a1', 'blocked'), o('i2', 'a2', 'todo', false)];
    assert.deepEqual(planApprovalWakes({ decision: 'approved', requesterAgentId: null, issueIds: ['i1', 'i2'], outcomes }), []);
    assert.deepEqual(
      planApprovalWakes({ decision: 'rejected', requesterAgentId: 'req', issueIds: ['i1'], outcomes: [o('i1', 'a1', 'blocked')] }),
      [{ agentId: 'req', role: 'requester', issueIds: ['i1'] }],
    );
  });
});

describe('APR-FIX wake skip reasons', () => {
  it('maps agent status and scheduler text to fixed categories', () => {
    assert.equal(wakeSkipReasonFromAgentStatus('active'), null);
    assert.equal(wakeSkipReasonFromAgentStatus('paused'), 'paused');
    assert.equal(wakeSkipReasonFromAgentStatus('archived'), 'archived');
    assert.equal(wakeSkipReasonFromAgentStatus(undefined), 'agent_not_found');
    assert.equal(wakeSkipReasonFromScheduler('agent status paused'), 'paused');
    assert.equal(wakeSkipReasonFromScheduler('company status paused'), 'company_inactive');
    assert.equal(wakeSkipReasonFromScheduler('over token budget'), 'over_budget');
    assert.equal(wakeSkipReasonFromScheduler('something else entirely'), 'skipped');
  });
  it('skip text says nobody will pick the issue up', () => {
    assert.match(formatWakeSkippedComment({ role: 'assignee', agentName: 'CEO', reason: 'paused' }), /assignee agent CEO is paused, so nobody will pick this issue up/);
    assert.match(formatWakeSkippedComment({ role: 'requester', agentName: null, reason: 'archived' }), /requesting agent is archived/);
  });
  it('failed wake text names the role and carries no scheduler detail', () => {
    assert.match(formatWakeFailedComment({ role: 'assignee', agentName: 'Dev' }), /^Wake not delivered: .*assignee agent Dev, so nobody will pick this issue up/);
    assert.match(formatWakeFailedComment({ role: 'requester', agentName: null }), /requesting agent, so it was not told about this decision/);
  });
});
