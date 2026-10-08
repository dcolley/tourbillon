/** #105 B2: /unlock `next` must never redirect off-origin. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SAFE_NEXT_FALLBACK, safeNext, sameOriginPath } from './safe-next';

describe('#105 safeNext (open redirect)', () => {
  const attacks = [
    '/\t/evil.com', // TAB stripped by browsers → //evil.com
    '/\n/evil.com', // LF stripped by browsers → //evil.com
    '/\r/evil.com',
    '//evil.com',
    '/\\evil.com', // backslash treated as slash → //evil.com
    '\\/evil.com',
    '/\\/evil.com',
    ' //evil.com',
    'https://evil.com',
    'javascript:alert(1)',
    'evil.com',
    '',
    '/\u0000/evil.com',
    '/\u00a0/evil.com',
  ];

  for (const v of attacks) {
    it(`rejects ${JSON.stringify(v)}`, () => {
      assert.equal(safeNext(v), SAFE_NEXT_FALLBACK);
    });
  }

  it('the TAB/LF payloads would really have escaped the origin (WHATWG URL)', () => {
    assert.equal(new URL('/\t/evil.com', 'https://tb.example').origin, 'https://evil.com');
    assert.equal(new URL('/\n/evil.com', 'https://tb.example').origin, 'https://evil.com');
  });

  it('missing/array values', () => {
    assert.equal(safeNext(undefined), SAFE_NEXT_FALLBACK);
    assert.equal(safeNext(null), SAFE_NEXT_FALLBACK);
    assert.equal(safeNext(['/agent/x', '//evil.com']), '/agent/x');
    assert.equal(safeNext(['//evil.com']), SAFE_NEXT_FALLBACK);
  });

  it('keeps legitimate same-origin paths (normalised)', () => {
    assert.equal(safeNext('/dashboard'), '/dashboard');
    assert.equal(safeNext('/agent/alice?tab=config#x'), '/agent/alice?tab=config#x');
    assert.equal(safeNext('/issue/A-1?next=%2F%2Fevil.com'), '/issue/A-1?next=%2F%2Fevil.com');
    assert.equal(safeNext('/a/../agent'), '/agent');
  });

  it('client re-check uses the real origin', () => {
    assert.equal(sameOriginPath('/agent/x', 'https://tb.example'), '/agent/x');
    assert.equal(sameOriginPath('/\t/evil.com', 'https://tb.example'), null);
    assert.equal(sameOriginPath('//evil.com', 'https://tb.example'), null);
  });
});
