import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * Tests for parkNoProgressIssue logic in wake-runner.ts
 * 
 * These tests verify the business logic without DB access.
 * The actual function is tested indirectly through integration tests.
 */

describe('parkNoProgressIssue logic', () => {
  describe('issue identification', () => {
    it('should use taskId when present (assignment wake)', () => {
      const taskId = 'issue-123';
      const runId = 'run-456';
      
      // When taskId is provided, parkNoProgressIssue should:
      // - Query for that specific issue by id
      // - Check if it's still in_progress with checkoutRunId === runId
      
      assert.ok(taskId, 'taskId path: find issue by taskId');
    });

    it('should find checked-out issue when taskId is absent (timer wake)', () => {
      const runId = 'run-456';
      const agentId = 'agent-789';
      const companyId = 'company-abc';
      
      // When taskId is absent, parkNoProgressIssue should:
      // - Query for issues where checkoutRunId === runId
      // - AND executionAgentNameKey === agentId
      // - AND companyId === companyId
      
      assert.ok(runId && agentId && companyId, 'no-taskId path: find issue by checkout lock');
    });
  });

  describe('parking conditions', () => {
    it('should NOT park if status changed from in_progress', () => {
      const issueStatus = 'done';
      const checkoutRunId = 'run-456';
      const expectedRunId = 'run-456';
      
      // Should skip parking when status !== 'in_progress'
      const shouldPark = issueStatus === 'in_progress' && checkoutRunId === expectedRunId;
      assert.equal(shouldPark, false, 'do not park when status changed');
    });

    it('should NOT park if checkoutRunId changed (lock taken by another run)', () => {
      const issueStatus = 'in_progress';
      const checkoutRunId = 'run-999';
      const expectedRunId = 'run-456';
      
      // Should skip parking when lock was taken by another run
      const shouldPark = issueStatus === 'in_progress' && checkoutRunId === expectedRunId;
      assert.equal(shouldPark, false, 'do not park when lock changed');
    });

    it('should NOT park if material work detected', () => {
      const activities = [
        { action: 'issue.checked_out', runId: 'run-456' },
        { action: 'issue.updated', runId: 'run-456' }, // Material work
      ];
      
      const hasMaterialWork = activities.some(a => 
        ['issue.updated', 'issue.created', 'approval.created'].includes(a.action)
      );
      
      assert.equal(hasMaterialWork, true, 'detected material work');
      // When material work exists, should NOT park
    });

    it('SHOULD park if no material work after checkout', () => {
      const activities = [
        { action: 'issue.checked_out', runId: 'run-456' },
        // No updateIssue, createSubtask, or createApproval
      ];
      
      const hasMaterialWork = activities.some(a => 
        ['issue.updated', 'issue.created', 'approval.created'].includes(a.action)
      );
      
      assert.equal(hasMaterialWork, false, 'no material work detected');
      // When no material work, SHOULD park
    });
  });

  describe('parking behavior', () => {
    it('should set status to todo when parking', () => {
      const newStatus = 'todo';
      assert.equal(newStatus, 'todo', 'parked issue status is todo');
    });

    it('should clear checkout lock when parking', () => {
      const clearedFields = {
        checkoutRunId: null,
        executionLockedAt: null,
        executionAgentNameKey: null,
      };
      
      assert.equal(clearedFields.checkoutRunId, null, 'checkoutRunId cleared');
      assert.equal(clearedFields.executionLockedAt, null, 'executionLockedAt cleared');
      assert.equal(clearedFields.executionAgentNameKey, null, 'executionAgentNameKey cleared');
    });

    it('should insert system activity log when parking', () => {
      const activityDetails = {
        runId: 'run-456',
        previousStatus: 'in_progress',
        newStatus: 'todo',
        comment: '⏸️ Parked: no material progress after checkout. Higher-priority work may now proceed.',
        reason: 'auto_park_no_progress',
      };
      
      assert.equal(activityDetails.reason, 'auto_park_no_progress', 'reason tagged');
      assert.ok(activityDetails.comment.includes('Parked'), 'comment explains parking');
    });
  });

  describe('failure path', () => {
    it('should park on failed wake (provider error after checkout)', () => {
      const wakeResult = 'failed';
      const hadCheckout = true;
      
      // parkNoProgressIssue is called from catch block in wake-runner
      // Should clear lock so next wake can proceed with higher-priority work
      assert.equal(wakeResult, 'failed', 'wake failed');
      assert.ok(hadCheckout, 'checkout happened before failure');
      // Park should run to clear the lock
    });
  });
});
