import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseGoalFilter } from './goal-filter';

describe('Goal Filter - searchParams Promise handling', () => {
  it('defaults to active when filter is undefined (searchParams not awaited)', () => {
    assert.strictEqual(parseGoalFilter(undefined), 'active');
  });

  it('defaults to active when filter is empty string', () => {
    assert.strictEqual(parseGoalFilter(''), 'active');
  });

  it('parses completed filter from URL query parameter', () => {
    assert.strictEqual(parseGoalFilter('completed'), 'completed');
  });

  it('parses archived filter from URL query parameter', () => {
    assert.strictEqual(parseGoalFilter('archived'), 'archived');
  });

  it('parses all filter from URL query parameter', () => {
    assert.strictEqual(parseGoalFilter('all'), 'all');
  });

  it('parses active filter from URL query parameter', () => {
    assert.strictEqual(parseGoalFilter('active'), 'active');
  });

  it('defaults to active for invalid filter values', () => {
    assert.strictEqual(parseGoalFilter('invalid'), 'active');
    assert.strictEqual(parseGoalFilter('unknown'), 'active');
    assert.strictEqual(parseGoalFilter('done'), 'active');
    assert.strictEqual(parseGoalFilter('paused'), 'active');
  });

  it('is case-sensitive and defaults to active for uppercase', () => {
    assert.strictEqual(parseGoalFilter('COMPLETED'), 'active');
    assert.strictEqual(parseGoalFilter('Completed'), 'active');
    assert.strictEqual(parseGoalFilter('ARCHIVED'), 'active');
    assert.strictEqual(parseGoalFilter('ALL'), 'active');
  });

  it('handles null by defaulting to active (type coercion)', () => {
    assert.strictEqual(parseGoalFilter(null as unknown as string), 'active');
  });

  it('goal filter does not accept paused (unlike project filter)', () => {
    assert.strictEqual(parseGoalFilter('paused'), 'active');
  });
});
