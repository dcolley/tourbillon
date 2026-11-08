import test from 'node:test';
import assert from 'node:assert/strict';

test('TN-FAIL-CLEAN-INNER', () => {
  assert.equal(1, 2, 'deliberate failing control');
});
