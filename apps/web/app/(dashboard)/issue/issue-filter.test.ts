import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseIssueFilter, statusesForFilter, ACTIVE_STATUSES } from './issue-filter';

describe('Issue Filter - Active Status', () => {
  it('ACTIVE_STATUSES constant includes only todo, in_progress, in_review, blocked', () => {
    const expected = ['todo', 'in_progress', 'in_review', 'blocked'];
    assert.deepStrictEqual([...ACTIVE_STATUSES], expected);
  });

  it('ACTIVE_STATUSES excludes done', () => {
    assert.ok(!(ACTIVE_STATUSES as readonly string[]).includes('done'));
  });

  it('ACTIVE_STATUSES excludes cancelled', () => {
    assert.ok(!(ACTIVE_STATUSES as readonly string[]).includes('cancelled'));
  });

  it('ACTIVE_STATUSES excludes backlog', () => {
    assert.ok(!(ACTIVE_STATUSES as readonly string[]).includes('backlog'));
  });

  it('parseIssueFilter defaults to active', () => {
    assert.strictEqual(parseIssueFilter(undefined), 'active');
    assert.strictEqual(parseIssueFilter(''), 'active');
  });

  it('statusesForFilter returns ACTIVE_STATUSES for active filter', () => {
    const statuses = statusesForFilter('active');
    assert.deepStrictEqual(statuses, ACTIVE_STATUSES);
  });

  it('statusesForFilter returns ACTIVE_STATUSES for mine filter', () => {
    // Mine filter also uses active statuses
    const statuses = statusesForFilter('mine');
    assert.deepStrictEqual(statuses, ACTIVE_STATUSES);
  });

  it('active filter status array has exactly 4 elements', () => {
    assert.strictEqual(ACTIVE_STATUSES.length, 4);
  });
});
