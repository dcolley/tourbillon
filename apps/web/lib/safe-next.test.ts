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
    assert.equal(safeNext('/%2e/agent'), '/agent');
    assert.equal(safeNext('/docs/a%5cb'), '/docs/a%5cb');
  });

  const normalisedNotSameSite = [
    '/.//example.com',
    '/a/..//example.com',
    '/..//example.com',
    '/%2e//example.com',
    '/%2E%2E//example.com',
    '/x/../..//example.com',
    '/./%2e/..//example.com',
    '/%5c/example.com',
    '/%5C%5Cexample.com',
    '/%2f/example.com',
    '/.%2f/example.com',
  ];
  for (const v of normalisedNotSameSite) {
    it(`rejects normalised paths that are not same-site: ${JSON.stringify(v)}`, () => {
      assert.equal(safeNext(v), SAFE_NEXT_FALLBACK);
      assert.equal(sameOriginPath(v, 'https://tb.example'), null);
    });
  }

  it('the result is always a single-slash path that passes the check again', () => {
    for (const v of ['/dashboard', '/a/../agent', '/x/./y/', '/%2e/agent', ...normalisedNotSameSite]) {
      const out = safeNext(v);
      assert.ok(out.startsWith('/') && !out.startsWith('//'), out);
      assert.equal(safeNext(out), out);
    }
  });

  // Double-encoded and upper-case forms: one decode turns these into `/%2f`, `/%5c`, `//` or `/\`.
  const encodedSlashVariants = [
    '/%252f/example.com',
    '/%252F/example.com',
    '/%255c/example.com',
    '/%255C/example.com',
    '/%255C%255Cexample.com',
    '/%252f%252fexample.com',
    '/%2F/example.com',
    '/%2F%2Fexample.com',
    '/%5C/example.com',
    '/.%2F/example.com',
  ];
  for (const v of encodedSlashVariants) {
    it(`rejects double-encoded / upper-case slash forms: ${JSON.stringify(v)}`, () => {
      assert.equal(safeNext(v), SAFE_NEXT_FALLBACK);
      assert.equal(sameOriginPath(v, 'https://tb.example'), null);
    });
  }

  it('keeps encoded slashes that are not at the start of the path', () => {
    assert.equal(safeNext('/docs/a%2Fb'), '/docs/a%2Fb');
    assert.equal(safeNext('/docs/a%252fb'), '/docs/a%252fb');
    assert.equal(safeNext('/docs/a%5Cb'), '/docs/a%5Cb');
  });

  it('UI-1: a missing or rejected next goes to `/`, which redirects to the stored view', () => {
    assert.equal(SAFE_NEXT_FALLBACK, '/');
    assert.equal(safeNext(undefined), '/');
    assert.equal(safeNext('//evil.com'), '/');
    assert.equal(safeNext('/'), '/');
  });

  it('client re-check uses the real origin', () => {
    assert.equal(sameOriginPath('/agent/x', 'https://tb.example'), '/agent/x');
    assert.equal(sameOriginPath('/\t/evil.com', 'https://tb.example'), null);
    assert.equal(sameOriginPath('//evil.com', 'https://tb.example'), null);
  });
});
