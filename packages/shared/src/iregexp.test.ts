/** APR-2: RFC 9485 I-Regexp subset and linear-time matching. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileIRegexp } from './iregexp';

const ok = (p: string) => {
  const r = compileIRegexp(p);
  assert.ok(r.ok, `${p}: ${!r.ok ? r.error : ''}`);
  return r.test;
};
const bad = (p: string) => assert.equal(compileIRegexp(p).ok, false, p);

describe('I-Regexp (RFC 9485)', () => {
  it('matches the whole string', () => {
    const t = ok('[a-z]+');
    assert.equal(t('rex'), true);
    assert.equal(t('Rex'), false);
    assert.equal(t('rex!'), false);
    assert.equal(ok('')(''), true);
  });

  it('supports alternation, groups, quantifiers, classes and categories', () => {
    assert.equal(ok('(ab|cd){2,3}')('abcdab'), true);
    assert.equal(ok('(ab|cd){2,3}')('ab'), false);
    assert.equal(ok('a{2}')('aa'), true);
    assert.equal(ok('a{2,}')('aaaa'), true);
    assert.equal(ok('[^0-9]*')('abc'), true);
    assert.equal(ok('[^0-9]*')('a1'), false);
    assert.equal(ok('\\p{Lu}\\p{Ll}+')('Émile'), true);
    assert.equal(ok('\\P{N}+')('abc'), true);
    assert.equal(ok('[-a]+')('-a-'), true);
    assert.equal(ok('[a-]+')('a-'), true);
    assert.equal(ok('\\.\\?\\n')('.?\n'), true);
    assert.equal(ok('.')('\n'), false);
    assert.equal(ok('.')('😀'), true);
    assert.equal(ok('^a$')('^a$'), true, '^ and $ are ordinary characters in I-Regexp');
  });

  it('refuses syntax outside I-Regexp', () => {
    for (const p of ['(?:a)', '(?=a)', 'a*?', '\\d', '\\w+', '\\1', '[a', 'a)', '(a', 'a{3,1}', '*a', '\\p{Greek}', '[]', '[z-a]', '{', 'a|*']) bad(p);
    bad('a'.repeat(257));
    bad('(a{1000}){1000}');
  });

  it('runs in linear time on patterns that make backtracking engines explode', () => {
    const t = ok('(a+)+b');
    const input = 'a'.repeat(50_000);
    const start = process.hrtime.bigint();
    assert.equal(t(input), false);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 5000, `took ${ms}ms`);
  });
});
