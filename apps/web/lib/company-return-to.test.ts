import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveReturnTo } from './company-return-to';
import { VIEW_PREFERENCE_STORAGE_KEY } from './view-preference';

const g = globalThis as { window?: unknown };

function storeView(view: string | null) {
  const store = new Map<string, string>();
  if (view !== null) store.set(VIEW_PREFERENCE_STORAGE_KEY, view);
  g.window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: () => {} } };
}

describe('company selector returnTo', () => {
  afterEach(() => {
    delete g.window;
  });

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
    '/\t/example.com',
    ' /dashboard',
    'javascript:alert(1)',
  ];

  const normalisedNotSameSite = [
    '/.//example.com',
    '/a/..//example.com',
    '/..//example.com',
    '/%2e//example.com',
    '/%2E%2E//example.com',
    '/x/../..//example.com',
    '/.\\/example.com',
    '/%5c/example.com',
    '/%5C%5Cexample.com',
    '/%2f/example.com',
    '/.%2f/example.com',
  ];
  for (const value of normalisedNotSameSite) {
    it(`rejects normalised paths that are not same-site: ${JSON.stringify(value)}`, () => {
      assert.equal(resolveReturnTo(value), '/assistant');
      storeView('control');
      assert.equal(resolveReturnTo(value), '/dashboard');
    });
  }
  for (const value of notRelative) {
    it(`falls back to the stored view for ${JSON.stringify(value)}`, () => {
      assert.equal(resolveReturnTo(value), '/assistant');
    });
  }

  it('missing value → stored view (default /assistant)', () => {
    assert.equal(resolveReturnTo(null), '/assistant');
    storeView('control');
    assert.equal(resolveReturnTo(null), '/dashboard');
    assert.equal(resolveReturnTo('https://example.com/x'), '/dashboard');
    storeView(null);
    assert.equal(resolveReturnTo(undefined), '/assistant');
  });

  it('the company selector routes returnTo through resolveReturnTo', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'company-selector.tsx'), 'utf8');
    assert.match(src, /from '@\/lib\/company-return-to'/);
    assert.doesNotMatch(src, /function resolveReturnTo/);
  });

  it('every navigation in the company selector goes through resolveReturnTo', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'company-selector.tsx'), 'utf8');
    const navCalls = [...src.matchAll(/router\s*\.\s*(push|replace|prefetch)\s*\(([^)]*\)?)/g)];
    assert.ok(navCalls.length >= 3, `expected the selector's router calls, found ${navCalls.length}`);
    for (const [call, , arg] of navCalls) {
      assert.match(arg, /^resolveReturnTo\(returnToParam\)$/, call);
    }
    assert.doesNotMatch(src, /\bredirect\s*\(/);
    assert.doesNotMatch(src, /(window\.)?location\s*(\.\s*(assign|replace|href)|=)/);
    assert.doesNotMatch(src, /<Link\b|href=\{\s*returnTo/);
  });
});
