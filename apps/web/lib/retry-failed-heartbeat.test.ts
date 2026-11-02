import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WakeReason } from '@tourbillon/shared';
import { TASK_SCOPED_WAKE_REASONS } from '@tourbillon/shared';
import { buildRetryHeartbeatJobData } from './retry-failed-heartbeat';

function failedRun(contextSnapshot: unknown) {
  return {
    id: 'run-failed-1',
    agentId: 'agent-1',
    companyId: 'company-1',
    contextSnapshot,
  };
}

describe('buildRetryHeartbeatJobData', () => {
  it('preserves assignment context from a full snapshot', () => {
    const snapshot = {
      wakeReason: 'assignment',
      taskId: 'issue-1',
      wakePayloadJson: '{"issue":{"id":"issue-1"},"newComments":[],"fallbackFetchNeeded":true}',
      linkedIssueIds: ['issue-1'],
      providerName: 'lmstudio',
      modelId: 'some/model',
    };
    const job = buildRetryHeartbeatJobData(failedRun(snapshot));

    assert.equal(job.agentId, 'agent-1');
    assert.equal(job.companyId, 'company-1');
    assert.equal(job.invocationSource, 'assignment');
    assert.equal(job.wakeReason, 'assignment');
    assert.equal(job.taskId, 'issue-1');
    assert.equal(job.wakePayloadJson, snapshot.wakePayloadJson);
    assert.deepEqual(job.linkedIssueIds, ['issue-1']);
    assert.equal(job.resumeOfRunId, 'run-failed-1');
  });

  it('preserves approval_resolved context (approvalId, status, note)', () => {
    const snapshot = {
      wakeReason: 'approval_resolved',
      approvalId: 'approval-1',
      approvalStatus: 'approved',
      approvalNote: 'ship it',
      taskId: 'issue-9',
    };
    const job = buildRetryHeartbeatJobData(failedRun(snapshot));

    assert.equal(job.wakeReason, 'approval_resolved');
    assert.equal(job.approvalId, 'approval-1');
    assert.equal(job.approvalStatus, 'approved');
    assert.equal(job.approvalNote, 'ship it');
    assert.equal(job.taskId, 'issue-9');
    assert.equal(job.resumeOfRunId, 'run-failed-1');
  });

  it('#275 approval retry keeps wakeReason + taskId + linkedIssueIds (scheduler must NOT assignee-check it)', () => {
    // The scheduler gates the assignee-mismatch check on wakeReason being task-scoped.
    // An approval_resolved retry must therefore survive with its reason intact (not
    // degraded to a task reason) plus the linked-issue context, or the retried requester
    // wake would die on the same "Task <id> is assigned to agent …, not …" check the
    // original failed on.
    const snapshot = {
      wakeReason: 'approval_resolved',
      approvalId: 'approval-7',
      approvalStatus: 'approved',
      taskId: 'issue-9',
      linkedIssueIds: ['issue-9', 'issue-10'],
    };
    const job = buildRetryHeartbeatJobData(failedRun(snapshot));

    assert.equal(job.wakeReason, 'approval_resolved');
    assert.equal(job.invocationSource, 'approval_resolved');
    assert.equal(job.approvalId, 'approval-7');
    assert.equal(job.taskId, 'issue-9');
    assert.deepEqual(job.linkedIssueIds, ['issue-9', 'issue-10']);
    assert.equal(job.resumeOfRunId, 'run-failed-1');
  });

  it('preserves an APR-2 response and non-binary outcome; drops an unknown status', () => {
    const response = { status: 'answered', value: 3, answerType: 'number', decidedBy: { kind: 'group', id: 'board' } };
    const job = buildRetryHeartbeatJobData(
      failedRun({ wakeReason: 'approval_resolved', approvalId: 'approval-2', approvalStatus: 'answered', approvalResponse: response }),
    );
    assert.equal(job.approvalStatus, 'answered');
    assert.deepEqual(job.approvalResponse, response);
    const junk = buildRetryHeartbeatJobData(
      failedRun({ wakeReason: 'approval_resolved', approvalId: 'approval-2', approvalStatus: 'weird', approvalResponse: { status: 'weird' } }),
    );
    assert.equal(junk.approvalStatus, undefined);
    assert.equal(junk.approvalResponse, undefined);
  });

  it('falls back to on_demand for an empty snapshot', () => {
    const job = buildRetryHeartbeatJobData(failedRun({}));

    assert.equal(job.agentId, 'agent-1');
    assert.equal(job.companyId, 'company-1');
    assert.equal(job.invocationSource, 'on_demand');
    assert.equal(job.wakeReason, 'on_demand');
    assert.equal(job.taskId, undefined);
    assert.equal(job.resumeOfRunId, 'run-failed-1');
  });

  it('falls back to on_demand for junk/whitespace snapshots', () => {
    const job = buildRetryHeartbeatJobData(
      failedRun({ wakeReason: '  ', taskId: '', wakePayloadJson: '   ' }),
    );

    assert.equal(job.wakeReason, 'on_demand');
    assert.equal(job.invocationSource, 'on_demand');
    assert.equal(job.taskId, undefined);
  });

  it('falls back to on_demand when a task-scoped reason lacks taskId', () => {
    const job = buildRetryHeartbeatJobData(
      failedRun({ wakeReason: 'assignment', wakePayloadJson: '{}' }),
    );

    assert.equal(job.wakeReason, 'on_demand');
  });

  it('falls back to on_demand when a task-scoped reason lacks wakePayloadJson', () => {
    const job = buildRetryHeartbeatJobData(failedRun({ wakeReason: 'assignment', taskId: 'issue-1' }));

    assert.equal(job.wakeReason, 'on_demand');
  });

  it('preserves timer wakes (no taskId required)', () => {
    const job = buildRetryHeartbeatJobData(failedRun({ wakeReason: 'timer' }));

    // timer is threadless in WakeRunner; keep it as-is so lineage stays honest.
    assert.equal(job.wakeReason, 'timer');
    assert.equal(job.resumeOfRunId, 'run-failed-1');
  });

  it('handles a null snapshot', () => {
    const job = buildRetryHeartbeatJobData(failedRun(null));

    assert.equal(job.wakeReason, 'on_demand');
    assert.equal(job.agentId, 'agent-1');
    assert.equal(job.companyId, 'company-1');
  });

  // #295 S295-S2: per-member mutation coverage for the shared task-scoped set. Before this
  // soft only `assignment` reached the task-scoped branch, so dropping
  // `issue_comment_mentioned` / `issue_blockers_resolved` / `issue_children_completed` from
  // the set survived the suite — the retry silently degraded to a context-free replay
  // (reason kept, taskId/payload guard gone), and the scheduler retried a task wake without
  // the payload it rebuilds the wake message from. The membership pin makes a vanished
  // per-member test RED instead of silently shrinking coverage; VALID_WAKE_REASONS gates
  // BEFORE the task-scoped branch, so dropping a member there degrades the retry too.
  describe('#295 S295-S2 task-scoped members (shared set)', () => {
    const CANONICAL_TASK_SCOPED = [
      'assignment',
      'issue_commented',
      'issue_comment_mentioned',
      'issue_blockers_resolved',
      'issue_children_completed',
    ];

    it('the shared set is exactly the canonical five (membership pin)', () => {
      assert.deepEqual(
        [...TASK_SCOPED_WAKE_REASONS].sort(),
        [...CANONICAL_TASK_SCOPED].sort(),
        'dropping a member here also removes its behavioural test below — this assertion is ' +
          'what turns the drop RED instead of silently shrinking coverage',
      );
    });

    for (const reason of CANONICAL_TASK_SCOPED) {
      it(`'${reason}' retry keeps reason + taskId + wakePayloadJson (task-scoped)`, () => {
        assert.ok(TASK_SCOPED_WAKE_REASONS.has(reason as WakeReason), `'${reason}' must stay task-scoped`);
        const snapshot = {
          wakeReason: reason,
          taskId: 'issue-7',
          wakePayloadJson: `{"issue":{"id":"issue-7"},"wakeReason":"${reason}"}`,
          linkedIssueIds: ['issue-7'],
        };

        const job = buildRetryHeartbeatJobData(failedRun(snapshot));

        assert.equal(
          job.wakeReason,
          reason,
          `'${reason}' fell through the task-scoped branch — VALID_WAKE_REASONS or the shared set ` +
            `lost the member and the retry degraded to a context-free replay`,
        );
        assert.equal(job.invocationSource, reason);
        assert.equal(job.taskId, 'issue-7');
        assert.equal(job.wakePayloadJson, snapshot.wakePayloadJson);
        assert.deepEqual(job.linkedIssueIds, ['issue-7']);
      });

      it(`'${reason}' retry without a payload degrades to on_demand (guarded, not replayed bare)`, () => {
        const job = buildRetryHeartbeatJobData(failedRun({ wakeReason: reason, taskId: 'issue-7' }));

        assert.equal(
          job.wakeReason,
          'on_demand',
          `'${reason}' took the context-free path — a task wake replayed without its payload ` +
            `would reach the scheduler missing the wake message context it is scoped to`,
        );
        assert.equal(job.taskId, undefined);
        assert.equal(job.wakePayloadJson, undefined);
      });
    }
  });
});
