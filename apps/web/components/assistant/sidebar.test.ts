/**
 * UI-2b: assistant sidebar rendering — sections and grouping, status badges, loading / error /
 * empty states, and the controls' handlers. ASYNC-0 (Slice A): agents only — no thread trees,
 * New chat, rename, pin, Pinned / Recent threads or thread search. The repo has no DOM test library, so this renders with react-dom/server and walks
 * the element tree to reach the controls.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AssistantAgent, AssistantThread } from '@/lib/assistant/sidebar';
import { initialSidebarState, type AssistantSidebarState } from '@/lib/assistant/sidebar-store';

type SidebarMod = typeof import('./sidebar');
type ButtonMod = typeof import('@/components/ui/button');
type ShellMod = typeof import('./assistant-shell');
let AssistantSidebarView: SidebarMod['AssistantSidebarView'];
let AssistantSidebar: SidebarMod['AssistantSidebar'];
let initials: SidebarMod['initials'];
let sidebarMod: SidebarMod;
let Button: ButtonMod['Button'];
let shell: ShellMod;

before(async () => {
  (globalThis as { React?: typeof React }).React = React;
  sidebarMod = await import('./sidebar');
  ({ AssistantSidebarView, AssistantSidebar, initials } = sidebarMod);
  ({ Button } = await import('@/components/ui/button'));
  shell = await import('./assistant-shell');
});

const agent = (id: string, extra: Partial<AssistantAgent> = {}): AssistantAgent => ({
  id,
  name: id,
  role: 'general',
  title: '',
  urlKey: `${id}-key`,
  icon: null,
  reportsToId: null,
  active: true,
  status: 'idle',
  pendingApprovals: 0,
  ...extra,
});
const thread = (id: string, agentId: string, extra: Partial<AssistantThread> = {}): AssistantThread => ({
  id,
  agentId,
  title: `Thread ${id}`,
  pinned: false,
  unread: false,
  lastActivityAt: '2026-10-01T10:00:00.000Z',
  createdAt: null,
  ...extra,
});
const ready = (threads: AssistantThread[]) => ({ status: 'ready' as const, threads, initialThreadId: threads[0]?.id ?? null, error: null });

const agents = [
  agent('ceo', { name: 'Chief Exec', status: 'waiting', pendingApprovals: 2 }),
  agent('eng', { name: 'Builder', role: 'engineer', reportsToId: 'ceo', status: 'running' }),
  agent('des', { name: 'Drawer', role: 'designer', reportsToId: 'ceo', active: false }),
];
const baseState = (over: Partial<AssistantSidebarState> = {}): AssistantSidebarState => ({
  ...initialSidebarState,
  phase: 'ready',
  companyId: 'c1',
  agents,
  threads: {
    ceo: ready([thread('t1', 'ceo', { title: 'Quarterly plan', pinned: true }), thread('t2', 'ceo', { unread: true, lastActivityAt: '2026-10-02T00:00:00Z' })]),
    eng: ready([thread('t3', 'eng', { title: 'Fix login', lastActivityAt: '2026-10-03T00:00:00Z' })]),
    des: ready([]),
  },
  ...over,
});

type Calls = Array<[string, ...unknown[]]>;
function viewProps(state: AssistantSidebarState, over: Record<string, unknown> = {}) {
  const calls: Calls = [];
  const rec = (name: string) => (...args: unknown[]) => void calls.push([name, ...args]);
  const props = {
    state,
    currentAgentKey: null as string | null,
    onSelectAgent: rec('select'),
    onRetry: rec('retry'),
    onDismissNotice: rec('dismiss'),
    ...over,
  };
  return { props, calls };
}
const html = (props: ReturnType<typeof viewProps>['props']) => renderToStaticMarkup(React.createElement(AssistantSidebarView, props as never));

/** Expand plain function components (not Button) and collect host/Button elements. */
function walk(node: React.ReactNode, out: React.ReactElement[] = []): React.ReactElement[] {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
    return out;
  }
  if (!React.isValidElement(node)) return out;
  const el = node as React.ReactElement<Record<string, unknown>>;
  if (typeof el.type === 'function' && el.type !== Button) {
    return walk((el.type as (p: unknown) => React.ReactNode)(el.props), out);
  }
  if (el.type === React.Fragment || typeof el.type === 'object') {
    walk(el.props.children as React.ReactNode, out);
    return out;
  }
  out.push(el);
  walk(el.props.children as React.ReactNode, out);
  return out;
}
const textOf = (n: React.ReactNode): string =>
  Array.isArray(n) ? n.map(textOf).join('') : typeof n === 'string' || typeof n === 'number' ? String(n) : React.isValidElement(n) ? textOf((n.props as { children?: React.ReactNode }).children) : '';
function control(props: ReturnType<typeof viewProps>['props'], match: (p: Record<string, unknown>) => boolean, nth = 0) {
  const all = walk(React.createElement(AssistantSidebarView, props as never)).filter((e) => match(e.props as Record<string, unknown>));
  assert.ok(all[nth], 'control not found');
  return all[nth].props as Record<string, (...a: unknown[]) => void> & Record<string, unknown>;
}
const byLabel = (label: string) => (p: Record<string, unknown>) => p['aria-label'] === label;
/** Clickable control by its text (containers whose only text is the control's are skipped). */
const byText = (text: string) => (p: Record<string, unknown>) =>
  typeof p.onClick === 'function' && textOf(p.children as React.ReactNode).trim() === text;
const click = () => {
  const e = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, prevented: false, preventDefault() {
    this.prevented = true;
  } };
  return e;
};

describe('UI-2b assistant sidebar view', () => {
  it('sections: My agents and Teams by role; ASYNC-0: no Pinned / Recent threads or thread trees', () => {
    const out = html(viewProps(baseState(), { currentAgentKey: 'ceo-key' }).props);
    const order = ['data-section="my-agents"', 'data-section="teams"'].map((s) => out.indexOf(s));
    assert.ok(order.every((i) => i >= 0), out);
    assert.ok(order[0] < order[1]);
    assert.ok(out.indexOf('data-team="designer"') < out.indexOf('data-team="engineer"'));
    assert.match(out, /data-agent="ceo-key" data-current="true"/);
    // Threads exist in the state, but none are shown.
    assert.doesNotMatch(out, /data-section="pinned"|data-section="recent"|data-agent-threads|data-thread=/);
    assert.doesNotMatch(out, /Quarterly plan|Fix login|Thread t2/);
    assert.doesNotMatch(out, /New thread|New chat|Rename thread|Pin thread|threads<\/|Show .* threads/);
  });

  it('ASYNC-0: no thread search', () => {
    const out = html(viewProps(baseState({ search: 'plan' })).props);
    assert.doesNotMatch(out, /Search threads|type="search"|data-section="results"/);
    assert.match(out, /data-section="my-agents"/, 'a stale search does not hide the agents');
  });

  it('agent rows: initials, status (waiting on you with count, running), paused agents', () => {
    const out = html(viewProps(baseState()).props);
    assert.equal(initials('Chief Exec'), 'CE');
    assert.equal(initials('  '), '?');
    assert.match(out, />CE</);
    assert.match(out, /data-agent-status="waiting"[^>]*>Waiting on you \(2\)/);
    assert.match(out, /data-agent-status="running"[^>]*>Running/);
    assert.match(out, /Paused/);
  });

  it('agent links go to the agent path (its one conversation); plain clicks call back', () => {
    const { props, calls } = viewProps(baseState());
    const out = html(props);
    assert.match(out, /href="\/assistant\/eng-key"/);
    assert.doesNotMatch(out, /href="\/assistant\/[^"]+\/[^"]+"/, 'no thread links');
    const link = control(props, (p) => p.href === '/assistant/eng-key');
    const e = click();
    link.onClick(e);
    assert.ok(e.prevented);
    link.onClick({ ...click(), metaKey: true });
    assert.deepEqual(calls, [['select', 'eng']]);
  });

  it('agent names render as text, never as markup', () => {
    const agentState = baseState({ agents: [agent('x', { name: '<b>bold</b>' })], threads: {} });
    const out = html(viewProps(agentState).props);
    assert.match(out, /&lt;b&gt;bold&lt;\/b&gt;/);
    assert.doesNotMatch(out, /<b>/);
  });

  it('selection not found: unknown agent only', () => {
    const agentMissing = html(viewProps(baseState(), { currentAgentKey: 'someone-else' }).props);
    assert.match(agentMissing, /data-selection-problem="agent-not-found"[^>]*>That agent is not in this company/);
    assert.doesNotMatch(html(viewProps(baseState(), { currentAgentKey: 'eng-key' }).props), /data-selection-problem/);
  });

  it('loading, load error with Retry, and no agents', () => {
    assert.match(html(viewProps({ ...initialSidebarState }).props), /Loading agents…/);
    const err = viewProps({ ...initialSidebarState, phase: 'error', loadError: 'No active company selected' });
    const out = html(err.props);
    assert.match(out, /role="alert"[^>]*>.*No active company selected/);
    control(err.props, byText('Retry')).onClick();
    assert.deepEqual(err.calls, [['retry']]);
    assert.match(html(viewProps(baseState({ agents: [], threads: {} })).props), /No agents in this company yet/);
  });

  it('notice banner shows the last failure and can be dismissed', () => {
    const { props, calls } = viewProps(baseState({ notice: { message: 'Could not load agents' } }));
    assert.match(html(props), /data-notice[^>]*>.*Could not load agents/);
    control(props, byText('Dismiss')).onClick();
    assert.deepEqual(calls, [['dismiss']]);
  });

  it('ASYNC-0: the sidebar loads agents only', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const src = await readFile(fileURLToPath(new URL('./sidebar.tsx', import.meta.url)), 'utf8');
    assert.match(src, /useAssistantSidebar\(\{ threadLists: false \}\)/);
    assert.doesNotMatch(src, /agent-thread-list|newThread|setPinned|rename\(/);
  });

  it("the shell renders the sidebar for the active company only (keyed so a switch reloads it)", () => {
    const find = (activeCompanyId: string | null) => {
      const found: React.ReactElement[] = [];
      const visit = (n: React.ReactNode) => {
        if (Array.isArray(n)) return n.forEach(visit);
        if (!React.isValidElement(n)) return;
        if (n.type === AssistantSidebar) found.push(n);
        visit((n.props as { children?: React.ReactNode }).children);
      };
      visit((shell.AssistantShell as (p: unknown) => React.ReactNode)({ companies: [], activeCompanyId, children: null }));
      return found;
    };
    const one = find('c1');
    assert.equal(one.length, 1);
    assert.equal(one[0].key, 'c1');
    assert.equal(find(null).length, 0);
    assert.doesNotMatch(renderToStaticMarkup(React.createElement(shell.AssistantEmptyState)), /<aside/);
  });
  describe('collapsible rail', () => {
    const aside = (out: string) => out.match(/<aside[^>]*>/)?.[0] ?? '';

    it('the full list shows from sm up (iPad portrait), not only from md', () => {
      const { props } = viewProps(baseState());
      const tag = aside(html(props));
      assert.match(tag, /data-collapsed="false"/);
      assert.match(tag, /(^|\s)sm:flex(\s|")/);
      assert.doesNotMatch(tag, /md:flex/);
      assert.match(tag, /w-72/);
    });

    it('no toggle without a handler; with one it collapses the list', () => {
      const { props } = viewProps(baseState());
      assert.doesNotMatch(html(props), /data-sidebar-toggle/);
      const { props: p2, calls } = viewProps(baseState(), { onToggleCollapsed: () => calls.push(['collapse']) });
      const toggle = control(p2, byLabel('Collapse agents sidebar'));
      assert.equal(toggle['aria-expanded'], true);
      toggle.onClick();
      assert.deepEqual(calls, [['collapse']]);
    });

    it('collapsed: an icon rail of agent initials (no search, sections or threads), current agent marked', () => {
      const { props, calls } = viewProps(baseState(), {
        collapsed: true,
        currentAgentKey: 'eng-key',
        onToggleCollapsed: () => calls.push(['expand']),
      });
      const out = html(props);
      const tag = aside(out);
      assert.match(tag, /data-collapsed="true"/);
      assert.match(tag, /w-14/);
      assert.match(tag, /(^|\s)sm:flex(\s|")/);
      assert.doesNotMatch(out, /Search threads|data-section|Quarterly plan/);
      assert.match(out, /data-agent-rail/);
      for (const a of agents) assert.match(out, new RegExp(`data-agent="${a.urlKey}"`));
      assert.match(out, /data-agent="eng-key" data-current="true"/);
      assert.match(out, /aria-label="Chief Exec \(waiting on you\)"/);
      assert.match(out, /aria-label="Drawer \(paused\)"/);
      assert.match(out, new RegExp(`>${initials('Chief Exec')}<`));
      control(props, byLabel('Builder (running)')).onClick({ preventDefault() {}, button: 0 });
      const toggle = control(props, byLabel('Expand agents sidebar'));
      assert.equal(toggle['aria-expanded'], false);
      toggle.onClick();
      assert.deepEqual(calls, [['select', 'eng'], ['expand']]);
    });

    it('the choice is kept in localStorage under tourbillon.assistant.sidebarCollapsed', () => {
      const g = globalThis as { window?: unknown };
      const prev = g.window;
      const data = new Map<string, string>();
      g.window = { localStorage: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } };
      try {
        assert.equal(sidebarMod.ASSISTANT_SIDEBAR_COLLAPSED_KEY, 'tourbillon.assistant.sidebarCollapsed');
        assert.equal(sidebarMod.readSidebarCollapsed(), false);
        sidebarMod.writeSidebarCollapsed(true);
        assert.equal(data.get('tourbillon.assistant.sidebarCollapsed'), 'true');
        assert.equal(sidebarMod.readSidebarCollapsed(), true);
        sidebarMod.writeSidebarCollapsed(false);
        assert.equal(sidebarMod.readSidebarCollapsed(), false);
        g.window = { localStorage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } };
        assert.equal(sidebarMod.readSidebarCollapsed(), false);
        sidebarMod.writeSidebarCollapsed(true);
        // Blocked storage: the choice still holds for this page.
        assert.equal(sidebarMod.readSidebarCollapsed(), true);
      } finally {
        g.window = prev;
        sidebarMod.writeSidebarCollapsed(false);
      }
    });
  });
});
