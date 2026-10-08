import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalToolArgsJson, toolArgsHash, toolCallSignature } from './tool-call-signature';

describe('canonicalToolArgsJson', () => {
  it('sorts keys at every depth', () => {
    assert.equal(
      canonicalToolArgsJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 3 } }),
      '{"a":{"c":3,"d":[{"y":2,"z":1}]},"b":1}',
    );
  });

  it('drops undefined-valued keys, keeps null, maps undefined array entries to null', () => {
    assert.equal(canonicalToolArgsJson({ a: 1, b: undefined, c: null }), '{"a":1,"c":null}');
    assert.equal(canonicalToolArgsJson([1, undefined, 3]), '[1,null,3]');
    assert.equal(canonicalToolArgsJson(undefined), 'null');
  });

  it('handles Date, bigint, non-finite numbers and cycles without throwing', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    assert.equal(canonicalToolArgsJson({ d: new Date('2026-10-07T00:00:00.000Z') }), '{"d":"2026-10-07T00:00:00.000Z"}');
    assert.equal(canonicalToolArgsJson({ n: 10n, x: Number.NaN }), '{"n":"10","x":null}');
    assert.equal(canonicalToolArgsJson(cyclic), '{"a":1,"self":"[Circular]"}');
  });

  it('distinguishes types that JSON would conflate only where it matters', () => {
    assert.notEqual(canonicalToolArgsJson({ a: '1' }), canonicalToolArgsJson({ a: 1 }));
    assert.notEqual(canonicalToolArgsJson({ a: [1, 2] }), canonicalToolArgsJson({ a: [2, 1] }));
  });
});

describe('toolArgsHash / toolCallSignature', () => {
  it('is stable across key order and undefined keys', () => {
    assert.equal(
      toolArgsHash({ path: 'x', opts: { b: 2, a: 1 } }),
      toolArgsHash({ opts: { a: 1, b: 2, c: undefined }, path: 'x' }),
    );
    assert.match(toolArgsHash({}), /^[0-9a-f]{64}$/);
  });

  it('keys on tool name and args', () => {
    assert.notEqual(toolCallSignature('a', { x: 1 }), toolCallSignature('b', { x: 1 }));
    assert.notEqual(toolCallSignature('a', { x: 1 }), toolCallSignature('a', { x: 2 }));
    assert.equal(toolCallSignature('a', undefined), toolCallSignature('a', undefined));
  });
});
