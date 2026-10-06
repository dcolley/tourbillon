import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseProjectFilter } from './project-filter';

describe('Project Filter - searchParams Promise handling', () => {
  it('defaults to active when filter is undefined (searchParams not awaited)', () => {
    assert.strictEqual(parseProjectFilter(undefined), 'active');
  });

  it('defaults to active when filter is empty string', () => {
    assert.strictEqual(parseProjectFilter(''), 'active');
  });

  it('parses completed filter from URL query parameter', () => {
    assert.strictEqual(parseProjectFilter('completed'), 'completed');
  });

  it('parses paused filter from URL query parameter', () => {
    assert.strictEqual(parseProjectFilter('paused'), 'paused');
  });

  it('parses archived filter from URL query parameter', () => {
    assert.strictEqual(parseProjectFilter('archived'), 'archived');
  });

  it('parses all filter from URL query parameter', () => {
    assert.strictEqual(parseProjectFilter('all'), 'all');
  });

  it('parses active filter from URL query parameter', () => {
    assert.strictEqual(parseProjectFilter('active'), 'active');
  });

  it('defaults to active for invalid filter values', () => {
    assert.strictEqual(parseProjectFilter('invalid'), 'active');
    assert.strictEqual(parseProjectFilter('unknown'), 'active');
    assert.strictEqual(parseProjectFilter('done'), 'active');
  });

  it('is case-sensitive and defaults to active for uppercase', () => {
    assert.strictEqual(parseProjectFilter('COMPLETED'), 'active');
    assert.strictEqual(parseProjectFilter('Completed'), 'active');
    assert.strictEqual(parseProjectFilter('ALL'), 'active');
  });

  it('handles null by defaulting to active (type coercion)', () => {
    assert.strictEqual(parseProjectFilter(null as unknown as string), 'active');
  });
});
