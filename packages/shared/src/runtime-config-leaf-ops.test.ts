/** S306-S3: runtimeConfigLeafOps — the leaf diff writers send to the nested jsonb merge. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runtimeConfigLeafOps } from './runtime-config-leaf-ops';

describe('S306-S3 runtimeConfigLeafOps', () => {
  it('sets only changed / new leaves and clears removed / undefined ones', () => {
    assert.deepEqual(
      runtimeConfigLeafOps({ a: 1, b: 2, c: 3, d: 4 }, { a: 1, b: 20, d: undefined, e: 5 }),
      { set: { b: 20, e: 5 }, clear: ['c', 'd'] },
    );
  });

  it('unchanged value (deep, key-order-insensitive) is not written', () => {
    assert.deepEqual(runtimeConfigLeafOps({ x: { p: 1, q: [1, 2] } }, { x: { q: [1, 2], p: 1 } }), {});
    assert.deepEqual(runtimeConfigLeafOps({ x: { p: 1 } }, { x: { p: 2 } }), { set: { x: { p: 2 } } });
    assert.deepEqual(runtimeConfigLeafOps({ x: [1, 2] }, { x: [2, 1] }), { set: { x: [2, 1] } });
  });

  it('absent / non-object snapshots diff as {}; dropIfEmpty is carried', () => {
    assert.deepEqual(runtimeConfigLeafOps(undefined, { a: 1 }), { set: { a: 1 } });
    assert.deepEqual(runtimeConfigLeafOps(null, { a: 1 }), { set: { a: 1 } });
    assert.deepEqual(runtimeConfigLeafOps(['z'], {}, { dropIfEmpty: true }), { dropIfEmpty: true });
    assert.deepEqual(runtimeConfigLeafOps({ a: 1 }, {}, { dropIfEmpty: true }), { clear: ['a'], dropIfEmpty: true });
  });

  it('a leaf whose snapshot value was undefined counts as absent (set, never a no-op)', () => {
    assert.deepEqual(runtimeConfigLeafOps({ a: undefined }, { a: 1 }), { set: { a: 1 } });
    assert.deepEqual(runtimeConfigLeafOps({ a: undefined }, {}), {});
  });
});
