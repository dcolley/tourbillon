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
});
