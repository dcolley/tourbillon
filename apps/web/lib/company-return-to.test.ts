import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveReturnTo, selectCompanyHref } from './company-return-to';
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

  describe('UI-1 CompanyGate → /select-company returnTo', () => {
    const returnToOf = (href: string) => new URL(href, 'http://x.invalid').searchParams.get('returnTo');

    it('a deep link keeps the page as returnTo, with its query', () => {
      assert.equal(selectCompanyHref('/dashboard'), '/select-company?returnTo=%2Fdashboard');
      assert.equal(selectCompanyHref('/assistant'), '/select-company?returnTo=%2Fassistant');
      assert.equal(returnToOf(selectCompanyHref('/issues', '?status=todo')), '/issues?status=todo');
      assert.equal(returnToOf(selectCompanyHref('/issues', 'status=todo')), '/issues?status=todo');
    });

    it('round trip: a no-company user at /dashboard lands on /dashboard, not the stored view', () => {
      for (const view of [null, 'assistant', 'control']) {
        storeView(view);
        assert.equal(resolveReturnTo(returnToOf(selectCompanyHref('/dashboard'))), '/dashboard');
        assert.equal(resolveReturnTo(returnToOf(selectCompanyHref('/assistant'))), '/assistant');
      }
    });

    it('no returnTo for /, the selector itself, or a missing pathname', () => {
      for (const p of ['/', '/select-company', '/select-company/x', '', null, undefined]) {
        assert.equal(selectCompanyHref(p), '/select-company', String(p));
      }
      assert.equal(selectCompanyHref('/', '?a=1'), '/select-company');
      assert.equal(selectCompanyHref('/select-company', '?returnTo=%2Fdashboard'), '/select-company');
      assert.equal(selectCompanyHref('/select-companyx'), '/select-company?returnTo=%2Fselect-companyx');
    });

    it('never forwards a path that is not same-site', () => {
      for (const p of ['//example.com', '/\\example.com', '/%2f/example.com', '/%252F/example.com', 'https://example.com/x']) {
        assert.equal(selectCompanyHref(p), '/select-company', p);
      }
    });

    it('CompanyGate uses selectCompanyHref for its only redirect', () => {
      const src = readFileSync(join(__dirname, '..', 'components', 'company-gate.tsx'), 'utf8');
      const calls = [...src.matchAll(/router\s*\.\s*(push|replace)\s*\(([^;]*)\)\s*;/g)];
      assert.equal(calls.length, 1, 'one redirect');
      assert.match(calls[0][2], /^selectCompanyHref\(pathname, window\.location\.search\)$/);
      assert.doesNotMatch(src, /['"]\/select-company['"]/);
    });
  });
});
