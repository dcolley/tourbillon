import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { trimEdgeBlank } from './edge-blank';

describe('trimEdgeBlank (shared with approval-reason)', () => {
  it('strips whitespace and zero-width at both ends; middle kept', () => {
    assert.equal(trimEdgeBlank('  \u200BSplit it\uFEFF\n'), 'Split it');
    assert.equal(trimEdgeBlank('\u200B\u200C\u200D\u2060\uFEFF'), '');
    assert.equal(trimEdgeBlank('ok'), 'ok');
  });
});
