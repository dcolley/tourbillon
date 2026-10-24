/**
 * UI-1 layout-level behaviour for `/assistant` and `/dashboard` (no DOM test library in the
 * repo, so the async server layouts and the shells are called directly and their element
 * trees inspected):
 * - no board session → companies are never listed and the page is not rendered;
 * - a board session without an active company → the shell renders, the page does not;
 * - both layouts wrap the shell in CompanyGate;
 * - both shell headers carry the Assistant | Control Pane switcher for their own view.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import * as React from 'react';

type El = React.ReactElement<Record<string, any>>;
type Layout = (props: { children: React.ReactNode }) => Promise<El>;

const stubs = new Map<string, (props: Record<string, unknown>) => null>();
function stub(moduleId: string, name: string) {
  const key = `${moduleId}#${name}`;
  let f = stubs.get(key);
  if (!f) {
    f = () => null;
    Object.defineProperty(f, 'name', { value: name });
    stubs.set(key, f);
  }
  return f;
}
/** A module whose named exports are all inert components. */
function stubModule(moduleId: string) {
  return new Proxy(
    {},
    {
      get(_t, name) {
        if (name === '__esModule') return true;
        if (typeof name !== 'string' || name === 'then' || name === 'default') return undefined;
        return stub(moduleId, name);
      },
    },
  );
}

const STUBBED = [
  '@/components/company-gate',
  '@/components/dashboard-sidebar',
  '@/components/company-switcher',
  '@/components/ui/sidebar',
  '@/components/ui/separator',
  '@/components/chat/chat-context',
  '@/components/search-board',
  '@/components/view-switcher',
  '@/components/logo',
  '@/components/theme-toggle',
];

const COMPANIES = [
  { id: 'co-1', name: 'Acme', issuePrefix: 'ACM', status: 'active' },
  { id: 'co-2', name: 'Beta', issuePrefix: 'BET', status: 'active' },
];

let boardSession = true;
let activeCompany: { id: string; name: string } | null = null;
let listCalls = 0;
let activeCalls = 0;

function children(el: El | null | undefined): El[] {
  if (!el || typeof el !== 'object') return [];
  return React.Children.toArray(el.props?.children).filter(
    (c): c is El => typeof c === 'object' && c !== null && 'type' in c,
  );
}
function findAll(el: El, pred: (e: El) => boolean): El[] {
  const out: El[] = pred(el) ? [el] : [];
  for (const c of children(el)) out.push(...findAll(c, pred));
  return out;
}

describe('UI-1 view layouts', () => {
  const originalRequire = Module.prototype.require;
  let layouts: Record<'assistant' | 'control', Layout>;
  let shells: {
    AssistantShell: (p: any) => El;
    DashboardShell: (p: any) => El;
  };

  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    Module.prototype.require = function (this: NodeModule, id: string) {
      if (STUBBED.includes(id)) return stubModule(id);
      if (id === '@/lib/company') {
        return {
          hasBoardSession: async () => boardSession,
          listCompanies: async () => {
            listCalls++;
            return COMPANIES;
          },
          getActiveCompanyOrNull: async () => {
            activeCalls++;
            return activeCompany;
          },
        };
      }
      if (id === '@/lib/build-info') return { getBuildInfo: () => ({ version: 'test' }) };
      return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;
    layouts = {
      assistant: (await import('./(assistant)/layout')).default as unknown as Layout,
      control: (await import('./(dashboard)/layout')).default as unknown as Layout,
    };
    const a = await import('../components/assistant/assistant-shell');
    const d = await import('../components/dashboard-shell');
    shells = {
      AssistantShell: a.AssistantShell as unknown as (p: any) => El,
      DashboardShell: d.DashboardShell as unknown as (p: any) => El,
    };
  });
  after(() => {
    Module.prototype.require = originalRequire;
  });
  beforeEach(() => {
    boardSession = true;
    activeCompany = null;
    listCalls = 0;
    activeCalls = 0;
  });

  const page = React.createElement('main', { 'data-testid': 'page' }, 'page');
  const shellOf = (gate: El) => {
    const [shell] = children(gate);
    assert.ok(shell, 'CompanyGate wraps the shell');
    return shell;
  };

  for (const view of ['assistant', 'control'] as const) {
    const shellName = view === 'assistant' ? 'AssistantShell' : 'DashboardShell';

    it(`${view}: wraps the ${shellName} in CompanyGate`, async () => {
      activeCompany = { id: 'co-1', name: 'Acme' };
      const gate = await layouts[view]({ children: page });
      assert.equal(gate.type, stub('@/components/company-gate', 'CompanyGate'));
      assert.equal(shellOf(gate).type, shells[shellName]);
    });

    it(`${view}: without a board session it never lists companies and renders no page`, async () => {
      boardSession = false;
      activeCompany = { id: 'co-1', name: 'Acme' };
      const shell = shellOf(await layouts[view]({ children: page }));
      assert.equal(listCalls, 0, 'listCompanies');
      assert.equal(activeCalls, 0, 'getActiveCompanyOrNull');
      assert.deepEqual(shell.props.companies, []);
      assert.equal(shell.props.activeCompanyId, null);
      assert.equal(shell.props.activeCompanyName, null);
      assert.equal(shell.props.children, null);
    });

    it(`${view}: a board session without an active company renders the shell but not the page`, async () => {
      const shell = shellOf(await layouts[view]({ children: page }));
      assert.equal(listCalls, 1);
      assert.equal(shell.props.companies.length, 2);
      assert.equal(shell.props.activeCompanyId, null);
      assert.equal(shell.props.children, null);
    });

    it(`${view}: with an active company the page renders and only safe company fields are passed`, async () => {
      activeCompany = { id: 'co-2', name: 'Beta' };
      const shell = shellOf(await layouts[view]({ children: page }));
      assert.equal(shell.props.children, page);
      assert.equal(shell.props.activeCompanyId, 'co-2');
      assert.equal(shell.props.activeCompanyName, 'Beta');
      assert.deepEqual(shell.props.companies, [
        { id: 'co-1', name: 'Acme', issuePrefix: 'ACM' },
        { id: 'co-2', name: 'Beta', issuePrefix: 'BET' },
      ]);
    });
  }

  const shellProps = {
    children: page,
    companies: [{ id: 'co-1', name: 'Acme', issuePrefix: 'ACM' }],
    activeCompanyId: 'co-1',
    activeCompanyName: 'Acme',
    buildInfo: { version: 'test' },
  };
  const isSwitcher = (e: El) => e.type === stub('@/components/view-switcher', 'ViewSwitcher');

  for (const [name, current] of [
    ['DashboardShell', 'control'],
    ['AssistantShell', 'assistant'],
  ] as const) {
    it(`${name}: the header carries the view switcher for "${current}"`, () => {
      const root = shells[name](shellProps);
      const [header, ...moreHeaders] = findAll(root, (e) => e.type === 'header');
      assert.ok(header, 'header');
      assert.equal(moreHeaders.length, 0);
      const inHeader = findAll(header, isSwitcher);
      assert.equal(inHeader.length, 1, 'one switcher in the header');
      assert.equal(inHeader[0].props.current, current);
      assert.equal(findAll(root, isSwitcher).length, 1, 'no other switcher');
      assert.equal(findAll(root, (e) => e.props['data-testid'] === 'page').length, 1, 'page rendered once');
    });
  }
});
