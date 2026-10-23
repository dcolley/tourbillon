import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RETURN_TO_FALLBACK, resolveReturnTo } from './return-to';

describe('company selector returnTo', () => {
  it('keeps a relative path, with its query and hash', () => {
    assert.equal(resolveReturnTo('/agent/alice'), '/agent/alice');
    assert.equal(resolveReturnTo('/issues?status=todo#top'), '/issues?status=todo#top');
    assert.equal(resolveReturnTo('/dashboard'), '/dashboard');
  });

  it('normalises dot segments', () => {
    assert.equal(resolveReturnTo('/a/../settings'), '/settings');
  });

  const notRelative = [
    '',
    'settings',
    'https://example.com/x',
    '//example.com',
    '/\\example.com',
    '\\/example.com',
    '/\t/example.com',
    '/\n/example.com',
    ' /dashboard',
    'javascript:alert(1)',
    `/${'a'.repeat(2048)}`,
  ];
  for (const value of notRelative) {
    it(`falls back for ${JSON.stringify(value.length > 40 ? `${value.slice(0, 20)}…` : value)}`, () => {
      assert.equal(resolveReturnTo(value), RETURN_TO_FALLBACK);
    });
  }

  it('falls back when missing', () => {
    assert.equal(resolveReturnTo(null), RETURN_TO_FALLBACK);
    assert.equal(resolveReturnTo(undefined), RETURN_TO_FALLBACK);
  });

  it('uses the given fallback (stored view) when the value is not usable', () => {
    assert.equal(resolveReturnTo('//example.com', () => '/assistant'), '/assistant');
    assert.equal(resolveReturnTo(null, () => '/assistant'), '/assistant');
    assert.equal(resolveReturnTo('/agent/alice', () => '/assistant'), '/agent/alice');
  });

  it('the company selector routes through resolveReturnTo', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'company-selector.tsx'), 'utf8');
    assert.match(src, /resolveReturnTo\(searchParams\.get\('returnTo'\)\)/);
    assert.doesNotMatch(src, /searchParams\.get\('returnTo'\)\s*\|\|/);
  });
});
