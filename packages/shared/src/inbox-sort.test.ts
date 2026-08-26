import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sortInboxIssues, type InboxIssue } from './inbox-sort';

function issue(
  id: string,
  status: string,
  priority: string,
  blockedByIssueIds?: string[] | null,
): InboxIssue {
  return { id, status, priority, blockedByIssueIds };
}

describe('sortInboxIssues', () => {
  it('ranks critical todo above medium in_progress', () => {
    const issues = [
      issue('a', 'in_progress', 'medium'),
      issue('b', 'todo', 'critical'),
    ];
    const sorted = sortInboxIssues(issues);
    assert.equal(sorted[0].id, 'b', 'critical todo should rank first');
    assert.equal(sorted[1].id, 'a', 'medium in_progress should rank second');
  });

  it('ranks high todo above low in_progress', () => {
    const issues = [
      issue('a', 'in_progress', 'low'),
      issue('b', 'todo', 'high'),
    ];
    const sorted = sortInboxIssues(issues);
    assert.equal(sorted[0].id, 'b', 'high todo should rank first');
    assert.equal(sorted[1].id, 'a', 'low in_progress should rank second');
  });

  it('ranks critical in_progress above medium in_progress', () => {
    const issues = [
      issue('a', 'in_progress', 'medium'),
      issue('b', 'in_progress', 'critical'),
    ];
    const sorted = sortInboxIssues(issues);
    assert.equal(sorted[0].id, 'b', 'critical in_progress should rank first');
    assert.equal(sorted[1].id, 'a', 'medium in_progress should rank second');
  });

  it('ranks medium in_progress above medium todo', () => {
    const issues = [
      issue('a', 'todo', 'medium'),
      issue('b', 'in_progress', 'medium'),
    ];
    const sorted = sortInboxIssues(issues);
    assert.equal(sorted[0].id, 'b', 'medium in_progress should rank first');
    assert.equal(sorted[1].id, 'a', 'medium todo should rank second');
  });

  it('does not prioritize blocked critical todo above medium in_progress', () => {
    const issues = [
      issue('a', 'in_progress', 'medium'),
      issue('b', 'todo', 'critical', ['blocker-id']),
    ];
    const sorted = sortInboxIssues(issues);
    assert.equal(sorted[0].id, 'a', 'medium in_progress should rank first');
    assert.equal(sorted[1].id, 'b', 'blocked critical todo should rank second');
  });

  it('ranks in_progress before in_review for same priority', () => {
    const issues = [
      issue('a', 'in_review', 'medium'),
      issue('b', 'in_progress', 'medium'),
    ];
    const sorted = sortInboxIssues(issues);
    assert.equal(sorted[0].id, 'b', 'in_progress should rank first');
    assert.equal(sorted[1].id, 'a', 'in_review should rank second');
  });

  it('ranks todo before blocked for same priority', () => {
    const issues = [
      issue('a', 'blocked', 'medium'),
      issue('b', 'todo', 'medium'),
    ];
    const sorted = sortInboxIssues(issues);
    assert.equal(sorted[0].id, 'b', 'todo should rank first');
    assert.equal(sorted[1].id, 'a', 'blocked should rank second');
  });

  it('preserves original order for identical priority and status', () => {
    const issues = [
      issue('a', 'todo', 'medium'),
      issue('b', 'todo', 'medium'),
      issue('c', 'todo', 'medium'),
    ];
    const sorted = sortInboxIssues(issues);
    assert.equal(sorted[0].id, 'a');
    assert.equal(sorted[1].id, 'b');
    assert.equal(sorted[2].id, 'c');
  });

  it('handles complex scenario with mixed priorities and statuses', () => {
    const issues = [
      issue('a', 'in_progress', 'low'),
      issue('b', 'todo', 'critical'),
      issue('c', 'in_progress', 'medium'),
      issue('d', 'todo', 'high'),
      issue('e', 'in_review', 'critical'),
      issue('f', 'blocked', 'high'),
    ];
    const sorted = sortInboxIssues(issues);
    
    // Critical/high workable first
    assert.equal(sorted[0].id, 'b', 'critical todo (workable)');
    assert.equal(sorted[1].id, 'd', 'high todo (workable)');
    
    // Then in_progress by priority
    assert.equal(sorted[2].id, 'c', 'medium in_progress');
    assert.equal(sorted[3].id, 'a', 'low in_progress');
    
    // Then in_review
    assert.equal(sorted[4].id, 'e', 'critical in_review');
    
    // Finally blocked
    assert.equal(sorted[5].id, 'f', 'high blocked');
  });
});
