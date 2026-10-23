/** UI-1: stored view preference (`tourbillon.view`), default assistant. */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_APP_VIEW,
  VIEW_PREFERENCE_STORAGE_KEY,
  homeRedirectPath,
  isAppView,
  readViewPreference,
  viewHomePath,
  writeViewPreference,
  type AppView,
} from './view-preference';

type G = { window?: unknown };
const g = globalThis as G;

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
  };
}

function throwingStorage() {
  return {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
}

describe('UI-1 view-preference', () => {
  let hadWindow: boolean;
  let originalWindow: unknown;

  beforeEach(() => {
    hadWindow = 'window' in g;
    originalWindow = g.window;
  });
  afterEach(() => {
    if (hadWindow) g.window = originalWindow;
    else delete g.window;
  });

  it('uses the storage key tourbillon.view', () => {
    assert.equal(VIEW_PREFERENCE_STORAGE_KEY, 'tourbillon.view');
  });

  it('defaults to assistant when nothing is stored', () => {
    g.window = { localStorage: memoryStorage() };
    assert.equal(DEFAULT_APP_VIEW, 'assistant');
    assert.equal(readViewPreference(), 'assistant');
    assert.equal(homeRedirectPath(), '/assistant');
  });

  it('defaults to assistant on the server (no window)', () => {
    delete g.window;
    assert.equal(readViewPreference(), 'assistant');
    assert.equal(homeRedirectPath(), '/assistant');
    assert.doesNotThrow(() => writeViewPreference('control'));
  });

  it('set: writes the choice and reads it back; / then lands on that view', () => {
    const storage = memoryStorage();
    g.window = { localStorage: storage };
    writeViewPreference('control');
    assert.equal(storage.data.get('tourbillon.view'), 'control');
    assert.equal(readViewPreference(), 'control');
    assert.equal(homeRedirectPath(), '/dashboard');
    writeViewPreference('assistant');
    assert.equal(readViewPreference(), 'assistant');
    assert.equal(homeRedirectPath(), '/assistant');
  });

  it('invalid stored value falls back to assistant', () => {
    for (const bad of ['', 'dashboard', 'Control', 'ASSISTANT', ' control', 'null', '{}']) {
      g.window = { localStorage: memoryStorage({ 'tourbillon.view': bad }) };
      assert.equal(readViewPreference(), 'assistant', JSON.stringify(bad));
    }
  });

  it('does not write an invalid value', () => {
    const storage = memoryStorage({ 'tourbillon.view': 'control' });
    g.window = { localStorage: storage };
    writeViewPreference('dashboard' as AppView);
    assert.equal(storage.data.get('tourbillon.view'), 'control');
  });

  it('storage errors fall back to the default and do not throw', () => {
    g.window = { localStorage: throwingStorage() };
    assert.equal(readViewPreference(), 'assistant');
    assert.doesNotThrow(() => writeViewPreference('control'));
  });

  it('isAppView and viewHomePath', () => {
    assert.equal(isAppView('assistant'), true);
    assert.equal(isAppView('control'), true);
    assert.equal(isAppView('dashboard'), false);
    assert.equal(isAppView(undefined), false);
    assert.equal(viewHomePath('assistant'), '/assistant');
    assert.equal(viewHomePath('control'), '/dashboard');
    assert.equal(viewHomePath('bogus' as AppView), '/assistant');
  });
});
