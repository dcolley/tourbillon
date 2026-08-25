import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  shouldParkIssue,
  hasParentUpdate,
  hasChildCreated,
  type ActivityEntry,
} from './park-helpers';
import type { Issue } from '@tourbillon/db';

/**
 * Tests for park helpers that import production code.
 * Tests call production functions directly with test data.
 */

describe('shouldParkIssue', () => {
  function mockIssue(
    status: string,
    checkoutRunId: string | null,
  ): Pick<Issue, 'status' | 'checkoutRunId'> {
    return { status, checkoutRunId } as Pick<Issue, 'status' | 'checkoutRunId'>;
  }

  it('should NOT park if status changed from in_progress', () => {
    const issue = mockIssue('done', 'run-456');
    const result = shouldParkIssue(issue as Issue, 'run-456');
    assert.equal(result, false, 'do not park when status is done');
  });

  it('should NOT park if checkoutRunId changed (lock taken by another run)', () => {
    const issue = mockIssue('in_progress', 'run-999');
    const result = shouldParkIssue(issue as Issue, 'run-456');
    assert.equal(result, false, 'do not park when lock changed');
  });

  it('SHOULD park if in_progress and locked by this run', () => {
    const issue = mockIssue('in_progress', 'run-456');
    const result = shouldParkIssue(issue as Issue, 'run-456');
    assert.equal(result, true, 'should park when in_progress with this run lock');
  });

  it('should NOT park if checkoutRunId is null', () => {
    const issue = mockIssue('in_progress', null);
    const result = shouldParkIssue(issue as Issue, 'run-456');
    assert.equal(result, false, 'do not park when lock is already cleared');
  });
});

describe('hasParentUpdate', () => {
  const checkoutTime = new Date('2026-08-25T12:00:00Z');
  const afterCheckout = new Date('2026-08-25T12:01:00Z');
  const beforeCheckout = new Date('2026-08-25T11:59:00Z');

  it('detects issue.updated from this run after checkout', () => {
    const activities: ActivityEntry[] = [
      {
        action: 'issue.checked_out',
        createdAt: checkoutTime,
        details: { runId: 'run-456' },
      },
      {
        action: 'issue.updated',
        createdAt: afterCheckout,
        details: { runId: 'run-456' },
      },
    ];

    const result = hasParentUpdate(activities, checkoutTime, 'run-456');
    assert.equal(result, true, 'detected updateIssue after checkout');
  });

  it('does NOT detect issue.updated from different run', () => {
    const activities: ActivityEntry[] = [
      {
        action: 'issue.updated',
        createdAt: afterCheckout,
        details: { runId: 'run-999' },
      },
    ];

    const result = hasParentUpdate(activities, checkoutTime, 'run-456');
    assert.equal(result, false, 'ignored updateIssue from different run');
  });

  it('does NOT detect issue.updated before checkout', () => {
    const activities: ActivityEntry[] = [
      {
        action: 'issue.updated',
        createdAt: beforeCheckout,
        details: { runId: 'run-456' },
      },
    ];

    const result = hasParentUpdate(activities, checkoutTime, 'run-456');
    assert.equal(result, false, 'ignored updateIssue before checkout');
  });

  it('does NOT detect non-update actions', () => {
    const activities: ActivityEntry[] = [
      {
        action: 'issue.checked_out',
        createdAt: afterCheckout,
        details: { runId: 'run-456' },
      },
    ];

    const result = hasParentUpdate(activities, checkoutTime, 'run-456');
    assert.equal(result, false, 'ignored non-update action');
  });
});

describe('hasChildCreated', () => {
  it('detects child issue.created from this run', () => {
    const childIds = ['child-1', 'child-2'];
    const childActivities: ActivityEntry[] = [
      {
        action: 'issue.created',
        createdAt: new Date(),
        details: { runId: 'run-456' },
        entityId: 'child-1',
      },
    ];

    const result = hasChildCreated(childIds, childActivities, 'run-456');
    assert.equal(result, true, 'detected createSubtask via child issue.created');
  });

  it('does NOT detect child created by different run', () => {
    const childIds = ['child-1'];
    const childActivities: ActivityEntry[] = [
      {
        action: 'issue.created',
        createdAt: new Date(),
        details: { runId: 'run-999' },
        entityId: 'child-1',
      },
    ];

    const result = hasChildCreated(childIds, childActivities, 'run-456');
    assert.equal(result, false, 'ignored child created by different run');
  });

  it('does NOT detect child not in childIds list', () => {
    const childIds = ['child-1'];
    const childActivities: ActivityEntry[] = [
      {
        action: 'issue.created',
        createdAt: new Date(),
        details: { runId: 'run-456' },
        entityId: 'child-99',
      },
    ];

    const result = hasChildCreated(childIds, childActivities, 'run-456');
    assert.equal(result, false, 'ignored non-child issue');
  });

  it('returns false when no children exist', () => {
    const childIds: string[] = [];
    const childActivities: ActivityEntry[] = [];

    const result = hasChildCreated(childIds, childActivities, 'run-456');
    assert.equal(result, false, 'no children means no subtask created');
  });
});

describe('material work detection scenarios', () => {
  const checkoutTime = new Date('2026-08-25T12:00:00Z');
  const afterCheckout = new Date('2026-08-25T12:01:00Z');

  it('updateIssue this run → do not park (material work)', () => {
    const activities: ActivityEntry[] = [
      {
        action: 'issue.updated',
        createdAt: afterCheckout,
        details: { runId: 'run-456' },
      },
    ];

    const hasMaterial = hasParentUpdate(activities, checkoutTime, 'run-456');
    assert.equal(hasMaterial, true, 'updateIssue is material work');
  });

  it('createSubtask this run → do not park (material work)', () => {
    const childIds = ['child-1'];
    const childActivities: ActivityEntry[] = [
      {
        action: 'issue.created',
        createdAt: afterCheckout,
        details: { runId: 'run-456' },
        entityId: 'child-1',
      },
    ];

    const hasMaterial = hasChildCreated(childIds, childActivities, 'run-456');
    assert.equal(hasMaterial, true, 'createSubtask is material work');
  });

  it('checkout only, no children → should park (no material work)', () => {
    const parentActivities: ActivityEntry[] = [
      {
        action: 'issue.checked_out',
        createdAt: afterCheckout,
        details: { runId: 'run-456' },
      },
    ];
    const childIds: string[] = [];
    const childActivities: ActivityEntry[] = [];

    const hasParent = hasParentUpdate(parentActivities, checkoutTime, 'run-456');
    const hasChild = hasChildCreated(childIds, childActivities, 'run-456');

    assert.equal(hasParent, false, 'no parent update');
    assert.equal(hasChild, false, 'no child created');
  });
});
