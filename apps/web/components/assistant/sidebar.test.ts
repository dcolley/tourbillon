/**
 * UI-2b: assistant sidebar rendering — sections and grouping, status badges, unread marker,
 * search results, pin cap, rename form, loading / error / empty states, and the controls'
 * handlers. The repo has no DOM test library, so this renders with react-dom/server and walks
 * the element tree to reach the controls.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ASSISTANT_MAX_PINS_PER_AGENT, type AssistantAgent, type AssistantThread } from '@/lib/assistant/sidebar';
import { initialSidebarState, type AssistantSidebarState } from '@/lib/assistant/sidebar-store';

type SidebarMod = typeof import('./sidebar');
type ButtonMod = typeof import('@/components/ui/button');
type ShellMod = typeof import('./assistant-shell');
let AssistantSidebarView: SidebarMod['AssistantSidebarView'];
let AssistantSidebar: SidebarMod['AssistantSidebar'];
let initials: SidebarMod['initials'];
let Button: ButtonMod['Button'];
let shell: ShellMod;

before(async () => {
  (globalThis as { React?: typeof React }).React = React;
  ({ AssistantSidebarView, AssistantSidebar, initials } = await import('./sidebar'));
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
    currentThreadId: null as string | null,
    expanded: new Set<string>(),
    editing: null,
    onSearch: rec('search'),
    onSelectAgent: rec('select'),
    onToggleAgent: rec('toggle'),
    onNewThread: rec('new'),
    onRetryThreads: rec('retryThreads'),
    onRetry: rec('retry'),
    onDismissNotice: rec('dismiss'),
    onOpenThread: rec('open'),
    onPin: rec('pin'),
    onStartRename: rec('startRename'),
    onRenameDraft: rec('draft'),
    onRenameSubmit: rec('submit'),
    onRenameCancel: rec('cancel'),
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
/** Only controls inside the element matching `scope`. */
function controlIn(
  props: ReturnType<typeof viewProps>['props'],
  scope: (p: Record<string, unknown>) => boolean,
  match: (p: Record<string, unknown>) => boolean,
) {
  const box = walk(React.createElement(AssistantSidebarView, props as never)).find((e) => scope(e.props as Record<string, unknown>));
  assert.ok(box, 'scope not found');
  const hit = walk((box.props as { children?: React.ReactNode }).children).find((e) => match(e.props as Record<string, unknown>));
  assert.ok(hit, 'control not found in scope');
  return hit.props as Record<string, (...a: unknown[]) => void> & Record<string, unknown>;
}
const click = () => {
  const e = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, prevented: false, preventDefault() {
    this.prevented = true;
  } };
  return e;
};

describe('UI-2b assistant sidebar view', () => {
  it('sections: Pinned threads, My agents, Teams by role, Recent threads', () => {
    const out = html(viewProps(baseState()).props);
    const order = ['data-section="pinned"', 'data-section="my-agents"', 'data-section="teams"', 'data-section="recent"'].map((s) => out.indexOf(s));
    assert.ok(order.every((i) => i >= 0), out);
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.ok(out.indexOf('data-team="designer"') < out.indexOf('data-team="engineer"'));
    assert.match(out, /data-agent="ceo-key"/);
    // Pinned section lists the pinned thread with its agent
    const pinned = out.slice(out.indexOf('data-section="pinned"'), out.indexOf('data-section="my-agents"'));
    assert.match(pinned, /Quarterly plan/);
    assert.match(pinned, /Chief Exec/);
    assert.doesNotMatch(pinned, /Fix login/);
    // Recent threads, newest first
    const recent = out.slice(out.indexOf('data-section="recent"'));
    assert.ok(recent.indexOf('Fix login') < recent.indexOf('Thread t2'));
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

  it('thread links go to /assistant/<agent-url-key>/<threadId>; unread marker; current thread', () => {
    const { props } = viewProps(baseState(), { currentAgentKey: 'ceo-key', currentThreadId: 't2', expanded: new Set(['ceo']) });
    const out = html(props);
    assert.match(out, /href="\/assistant\/ceo-key\/t2"/);
    assert.match(out, /data-unread/);
    assert.match(out, /data-thread="t2" data-current="true"/);
    assert.match(out, /data-agent-threads="ceo"/);
    assert.doesNotMatch(out, /data-agent-threads="eng"/, 'collapsed agents do not list threads');
  });

  it('search shows matching threads across agents, or a no-match message', () => {
    const { props, calls } = viewProps(baseState({ search: 'PLAN' }));
    const out = html(props);
    assert.match(out, /data-section="results"/);
    assert.match(out, /Quarterly plan/);
    assert.doesNotMatch(out, /Fix login/);
    assert.doesNotMatch(out, /data-section="my-agents"/);
    assert.match(html(viewProps(baseState({ search: 'zzz' })).props), /No threads match “zzz”/);
    const input = control(props, byLabel('Search threads'));
    input.onChange({ target: { value: 'fix' } });
    assert.deepEqual(calls, [['search', 'fix']]);
  });

  it('pin: disabled with an explanation once the agent has the maximum pinned; unpin stays enabled', () => {
    const many = Array.from({ length: ASSISTANT_MAX_PINS_PER_AGENT }, (_, i) => thread(`p${i}`, 'eng', { pinned: true }));
    const state = baseState({ threads: { ...baseState().threads, eng: ready([...many, thread('free', 'eng')]) } });
    const { props } = viewProps(state, { expanded: new Set(['eng']) });
    const out = html(props);
    assert.match(out, new RegExp(`aria-label="Pin thread"[^>]*title="Pin limit reached \\(${ASSISTANT_MAX_PINS_PER_AGENT} threads per agent\\)"[^>]*disabled`));
    const pin = control(props, (p) => p['aria-label'] === 'Pin thread');
    assert.equal(pin.disabled, true);
    const unpin = control(props, byLabel('Unpin thread'));
    assert.equal(unpin.disabled, false);
    // under the cap: pin enabled and calls back
    const under = viewProps(baseState(), { expanded: new Set(['eng']) });
    const pin2 = controlIn(under.props, (p) => p['data-agent-threads'] === 'eng', byLabel('Pin thread'));
    assert.equal(pin2.disabled, false);
    pin2.onClick();
    assert.deepEqual(under.calls, [['pin', 'eng', 't3', true]]);
  });

  it('pending pin disables the button', () => {
    const { props } = viewProps(baseState({ pending: { 'pin:t3': true } }), { expanded: new Set(['eng']) });
    assert.equal(controlIn(props, (p) => p['data-agent-threads'] === 'eng', byLabel('Pin thread')).disabled, true);
  });

  it('rename: inline form with the draft; save / cancel / escape call back', () => {
    const { props, calls } = viewProps(baseState(), { expanded: new Set(['eng']), editing: { threadId: 't3', draft: 'New name' } });
    const out = html(props);
    assert.match(out, /data-thread-edit="t3"/);
    assert.match(out, /aria-label="Thread title"[^>]*value="New name"/);
    const form = control(props, (p) => p['data-thread-edit'] === 't3');
    let prevented = false;
    form.onSubmit({ preventDefault: () => (prevented = true) });
    assert.ok(prevented);
    const input = control(props, byLabel('Thread title'));
    input.onChange({ target: { value: 'Newer' } });
    input.onKeyDown({ key: 'Escape' });
    control(props, byText('Cancel')).onClick();
    assert.deepEqual(calls, [['submit', 'eng', 't3'], ['draft', 'Newer'], ['cancel'], ['cancel']]);
    const view = viewProps(baseState(), { expanded: new Set(['eng']) });
    controlIn(view.props, (p) => p['data-agent-threads'] === 'eng', byLabel('Rename thread')).onClick();
    assert.deepEqual(view.calls, [['startRename', 't3', 'Fix login']]);
  });

  it('agent selection, expand toggle, new thread and opening a thread call back (plain clicks only)', () => {
    const { props, calls } = viewProps(baseState(), { expanded: new Set(['eng']) });
    const link = control(props, (p) => p.href === '/assistant/eng-key');
    const e = click();
    link.onClick(e);
    assert.ok(e.prevented);
    link.onClick({ ...click(), metaKey: true });
    control(props, byLabel('Show Chief Exec threads')).onClick();
    control(props, byText('New thread')).onClick();
    const threadLink = control(props, (p) => p.href === '/assistant/eng-key/t3');
    threadLink.onClick(click());
    assert.deepEqual(calls, [['select', 'eng'], ['toggle', 'ceo'], ['new', 'eng'], ['open', 'eng', 't3', '/assistant/eng-key/t3']]);
  });

  it('titles render as text, never as markup', () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const state = baseState({ threads: { ...baseState().threads, eng: ready([thread('t3', 'eng', { title: hostile })]) } });
    for (const out of [html(viewProps(state, { expanded: new Set(['eng']) }).props), html(viewProps({ ...state, search: 'img' }).props)]) {
      assert.ok(out.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;'), out);
      assert.doesNotMatch(out, /<img|<script/);
    }
    const agentState = baseState({ agents: [agent('x', { name: '<b>bold</b>' })], threads: {} });
    assert.match(html(viewProps(agentState).props), /&lt;b&gt;bold&lt;\/b&gt;/);
  });

  it('selection not found: unknown agent or a thread missing from the list', () => {
    const agentMissing = html(viewProps(baseState(), { currentAgentKey: 'someone-else', currentThreadId: 'x' }).props);
    assert.match(agentMissing, /data-selection-problem="agent-not-found"[^>]*>That agent is not in this company/);
    const threadMissing = html(viewProps(baseState(), { currentAgentKey: 'eng-key', currentThreadId: 'nope' }).props);
    assert.match(threadMissing, /data-selection-problem="thread-not-found"[^>]*>That thread was not found for this agent/);
    const fine = html(viewProps(baseState(), { currentAgentKey: 'eng-key', currentThreadId: 't3' }).props);
    assert.doesNotMatch(fine, /data-selection-problem/);
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

  it("an agent's thread list: loading, error with Retry, empty", () => {
    const state = baseState({
      threads: {
        ceo: { status: 'loading', threads: [], initialThreadId: null, error: null },
        eng: { status: 'error', threads: [], initialThreadId: null, error: 'Internal error' },
        des: ready([]),
      },
    });
    const { props, calls } = viewProps(state, { expanded: new Set(['ceo', 'eng', 'des']) });
    const out = html(props);
    assert.match(out, /Loading threads…/);
    assert.match(out, /Internal error/);
    assert.match(out, /No threads yet/);
    control(props, byText('Retry')).onClick();
    assert.deepEqual(calls, [['retryThreads', 'eng']]);
  });

  it('notice banner shows the last failure and can be dismissed', () => {
    const { props, calls } = viewProps(baseState({ notice: { message: 'Pin limit reached (50 threads per agent)' } }));
    assert.match(html(props), /data-notice[^>]*>.*Pin limit reached/);
    control(props, byText('Dismiss')).onClick();
    assert.deepEqual(calls, [['dismiss']]);
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
});
