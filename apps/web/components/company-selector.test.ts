/**
 * UI-1: where the company selector goes once a company is chosen. No DOM test library, so the
 * component is called directly with React's hooks replaced (effects are collected and run by
 * hand) and the real returnTo / stored-view helpers.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import * as React from 'react';
import { VIEW_PREFERENCE_STORAGE_KEY } from '../lib/view-preference';

type El = React.ReactElement<Record<string, any>>;

const g = globalThis as { window?: unknown; React?: unknown };
let effects: Array<() => void> = [];
let pushes: string[] = [];
let stored: string[] = [];
let synced: string[] = [];
let search = '';

const fakeReact = {
  ...React,
  useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => {}],
  useEffect: (fn: () => void) => {
    effects.push(fn);
  },
};

const stubs = new Map<string, () => null>();
const stubModule = (moduleId: string) =>
  new Proxy(
    {},
    {
      get(_t, name) {
        if (name === '__esModule') return true;
        if (typeof name !== 'string' || name === 'then' || name === 'default') return undefined;
        const key = `${moduleId}#${name}`;
        if (!stubs.has(key)) stubs.set(key, () => null);
        return stubs.get(key);
      },
    },
  );

function storeView(view: string | null) {
  const store = new Map<string, string>();
  if (view !== null) store.set(VIEW_PREFERENCE_STORAGE_KEY, view);
  g.window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: () => {} } };
}

function findAll(el: unknown, pred: (e: El) => boolean): El[] {
  if (!el || typeof el !== 'object' || !('props' in (el as object))) return [];
  const e = el as El;
  const out = pred(e) ? [e] : [];
  for (const c of React.Children.toArray(e.props.children)) out.push(...findAll(c, pred));
  return out;
}

const tick = () => new Promise((r) => setImmediate(r));
const company = (id: string) => ({ id, name: id, issuePrefix: id.toUpperCase(), status: 'active' });

describe('UI-1 CompanySelector navigation', () => {
  const originalRequire = Module.prototype.require;
  let CompanySelector: (p: { companies: unknown[] }) => El;

  before(async () => {
    g.React = React;
    Module.prototype.require = function (this: NodeModule, id: string) {
      if (id === 'react' && /company-selector\.tsx$/.test(this.filename ?? '')) return fakeReact;
      if (id === 'next/navigation') {
        return {
          useRouter: () => ({ push: (p: string) => pushes.push(p), replace: () => {} }),
          useSearchParams: () => new URLSearchParams(search),
        };
      }
      if (id === '@/lib/company-storage') return { setStoredCompanyId: (cid: string) => stored.push(cid) };
      if (id === '@/app/(dashboard)/company/actions') {
        return {
          syncActiveCompanyAction: async (cid: string) => {
            synced.push(cid);
            return { ok: true };
          },
        };
      }
      if (
        id === '@/components/create-company-dialog' ||
        id === '@/components/ui/button' ||
        id === '@/components/ui/card' ||
        id === '@/lib/status-badges'
      ) {
        return stubModule(id);
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;
    ({ CompanySelector } = (await import('./company-selector')) as unknown as {
      CompanySelector: typeof CompanySelector;
    });
  });
  after(() => {
    Module.prototype.require = originalRequire;
  });
  beforeEach(() => {
    effects = [];
    pushes = [];
    stored = [];
    synced = [];
    search = '';
    storeView(null);
  });
  afterEach(() => {
    delete g.window;
  });

  async function autoSelectOnly(): Promise<string[]> {
    CompanySelector({ companies: [company('co-1')] });
    for (const fn of effects) fn();
    await tick();
    assert.deepEqual(stored, ['co-1']);
    assert.deepEqual(synced, ['co-1']);
    return pushes;
  }

  it('single company, no returnTo: goes to the stored view (default /assistant)', async () => {
    assert.deepEqual(await autoSelectOnly(), ['/assistant']);
  });

  it('single company, no returnTo, stored Control Pane: goes to /dashboard', async () => {
    storeView('control');
    assert.deepEqual(await autoSelectOnly(), ['/dashboard']);
  });

  it('single company with a safe returnTo goes there; an unsafe one falls back to the stored view', async () => {
    search = 'returnTo=%2Fdashboard';
    assert.deepEqual(await autoSelectOnly(), ['/dashboard']);
    for (const bad of ['%2F%2Fexample.com', 'https%3A%2F%2Fexample.com', '%2F%252F%2Fexample.com']) {
      effects = [];
      pushes = [];
      stored = [];
      synced = [];
      search = `returnTo=${bad}`;
      assert.deepEqual(await autoSelectOnly(), ['/assistant'], bad);
    }
  });

  it('picking from the list: no returnTo goes to the stored view', async () => {
    storeView('control');
    const el = CompanySelector({ companies: [company('co-1'), company('co-2')] });
    for (const fn of effects) fn();
    await tick();
    assert.deepEqual(pushes, [], 'no auto-select with two companies');
    const buttons = findAll(el, (e) => e.type === 'button' && typeof e.props.onClick === 'function');
    assert.equal(buttons.length, 2);
    buttons[1].props.onClick();
    await tick();
    assert.deepEqual(stored, ['co-2']);
    assert.deepEqual(pushes, ['/dashboard']);
  });

  it('a newly created company: returnTo when safe, otherwise the stored view', async () => {
    const dialog = (el: El) =>
      findAll(el, (e) => typeof e.props.onCreated === 'function')[0] ?? assert.fail('dialog');
    await dialog(CompanySelector({ companies: [] })).props.onCreated('co-new');
    assert.deepEqual(pushes, ['/assistant']);
    search = 'returnTo=%2Fissues%3Fstatus%3Dtodo';
    await dialog(CompanySelector({ companies: [] })).props.onCreated('co-new');
    assert.deepEqual(pushes, ['/assistant', '/issues?status=todo']);
  });
});
