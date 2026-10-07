import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
});
