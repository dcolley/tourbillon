/**
 * UI-4: shared company picker. No DOM test library in the repo, so this checks react-dom/server
 * markup and walks the stateless view's element tree (like view-switcher.test.ts).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

type El = React.ReactElement<Record<string, any>>;
type Mod = typeof import('./company-switcher');
type SelectMod = typeof import('@/components/ui/select');
type ShellMod = typeof import('./assistant/assistant-shell');
type DashMod = typeof import('./dashboard-shell');
type SidebarUiMod = typeof import('@/components/ui/sidebar');

const LONG = 'An Extremely Long Company Name That Will Not Fit In The Picker Ltd';
const companies = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Acme', issuePrefix: 'ACM' },
  { id: '22222222-2222-4222-8222-222222222222', name: LONG, issuePrefix: 'LNG' },
];

function walk(node: React.ReactNode, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
    return out;
  }
  if (!React.isValidElement(node)) return out;
  out.push(node as El);
  walk((node.props as { children?: React.ReactNode }).children, out);
  return out;
}

describe('UI-4 CompanySwitcher', () => {
  let mod: Mod;
  let ui: SelectMod;
  let shell: ShellMod;
  let dash: DashMod;
  let sidebarUi: SidebarUiMod;

  before(async () => {
    // tsx compiles JSX with the classic runtime (tsconfig jsx: preserve).
    (globalThis as { React?: unknown }).React = React;
    mod = await import('./company-switcher');
    ui = await import('@/components/ui/select');
    shell = await import('./assistant/assistant-shell');
    dash = await import('./dashboard-shell');
    sidebarUi = await import('@/components/ui/sidebar');
  });

  const view = (over: Partial<Parameters<Mod['CompanySwitcherView']>[0]> = {}) => {
    const calls: Array<[string, string?]> = [];
    const props = {
      companies,
      activeCompanyId: companies[1].id,
      onSelect: (id: string) => calls.push(['select', id]),
      onCreate: () => calls.push(['create']),
      ...over,
    };
    const tree = mod.CompanySwitcherView(props) as El;
    return { props, calls, tree, els: walk(tree) };
  };

  it('truncates the active name with an ellipsis and shows the full name on hover', () => {
    const { props } = view();
    const html = renderToStaticMarkup(React.createElement(mod.CompanySwitcherView, props));
    const label = html.match(/<span dir="auto" class="([^"]*)" title="([^"]*)">([^<]*)<\/span>/);
    assert.ok(label, html);
    assert.ok(label[1].split(' ').includes('truncate'), label[1]);
    assert.ok(label[1].split(' ').includes('min-w-0'), label[1]);
    assert.equal(label[2], LONG);
    assert.equal(label[3], LONG);
    assert.match(html, /aria-label="Company"/);
  });

  it('truncates long names in the dropdown and keeps the full name as the title', () => {
    const { els } = view();
    const items = els.filter((e) => e.type === ui.SelectItem && e.props.value !== mod.NEW_COMPANY_VALUE);
    assert.equal(items.length, 2);
    for (const [i, item] of items.entries()) {
      assert.equal(item.props.title, companies[i].name);
      const name = walk(item.props.children).find((e) => e.props.title === companies[i].name);
      assert.ok(name);
      assert.match(name.props.className, /\btruncate\b/);
      assert.match(name.props.className, /\bmin-w-0\b/);
    }
  });

  it('shows "Select company" when no company is active', () => {
    const html = renderToStaticMarkup(
      React.createElement(mod.CompanySwitcherView, { ...view().props, activeCompanyId: null }),
    );
    assert.match(html, /title="Select company">Select company</);
  });

  it('lists the companies, then a divider, then "New company" as the last option', () => {
    const { els } = view();
    const content = els.find((e) => e.type === ui.SelectContent);
    assert.ok(content);
    const children = React.Children.toArray(content.props.children) as El[];
    const n = children.length;
    assert.equal(n, companies.length + 2);
    assert.deepEqual(
      children.slice(0, companies.length).map((c) => c.props.value),
      companies.map((c) => c.id),
    );
    assert.equal(children[n - 2].type, ui.SelectSeparator);
    assert.equal(children[n - 1].type, ui.SelectItem);
    assert.equal(children[n - 1].props.value, mod.NEW_COMPANY_VALUE);
    assert.equal(children[n - 1].props.label, 'New company');
  });

  it('has no standalone "New company" row outside the dropdown', () => {
    const { tree, props } = view();
    const content = walk(tree).find((e) => e.type === ui.SelectContent)!;
    const outside = walk(tree).filter((e) => !walk(content).includes(e));
    assert.ok(!outside.some((e) => String(e.props.children ?? '').includes('New company')));
    const html = renderToStaticMarkup(React.createElement(mod.CompanySwitcherView, props));
    assert.doesNotMatch(html, /New company/);
  });

  it('picking "New company" opens the create flow and does not switch company', () => {
    const { els, calls } = view();
    const select = els.find((e) => e.type === ui.Select)!;
    select.props.onValueChange(mod.NEW_COMPANY_VALUE);
    assert.deepEqual(calls, [['create']]);
  });

  it('picking another company still switches to it; the active one or an empty value does nothing', () => {
    const { els, calls } = view();
    const select = els.find((e) => e.type === ui.Select)!;
    select.props.onValueChange(companies[0].id);
    select.props.onValueChange(companies[1].id);
    select.props.onValueChange(null);
    assert.deepEqual(calls, [['select', companies[0].id]]);
    assert.equal(select.props.value, companies[1].id);
  });

  it('companySwitcherAction maps dropdown values to actions', () => {
    assert.deepEqual(mod.companySwitcherAction(mod.NEW_COMPANY_VALUE, 'a'), { type: 'create' });
    assert.deepEqual(mod.companySwitcherAction('b', 'a'), { type: 'select', companyId: 'b' });
    assert.equal(mod.companySwitcherAction('a', 'a'), null);
    assert.equal(mod.companySwitcherAction(null, 'a'), null);
    assert.equal(mod.companySwitcherAction('', null), null);
  });

  it('uses theme tokens only (no hard-coded colours)', () => {
    const src = readFileSync(fileURLToPath(new URL('./company-switcher.tsx', import.meta.url)), 'utf8');
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b|\b(?:text|bg|border|ring)-(?:white|black|gray|slate|zinc|neutral|stone|red|blue|green)-?/);
  });

  it('the Assistant view renders the shared picker with no width override of its own', () => {
    const tree = (shell.AssistantShell as (p: unknown) => React.ReactNode)({
      companies,
      activeCompanyId: companies[0].id,
      activeCompanyName: 'Acme',
      children: null,
    });
    const els = walk(tree);
    const picker = els.find((e) => e.type === mod.CompanySwitcher);
    assert.ok(picker, 'AssistantShell renders CompanySwitcher');
    const wrapper = els.find((e) => e.props['data-assistant-company-picker'] !== undefined);
    assert.ok(wrapper && walk(wrapper.props.children).includes(picker!));
    assert.doesNotMatch(wrapper.props.className, /(^|\s)(min-|max-)?w-/, wrapper.props.className);
    // Shown at all widths, as in the Control Pane (no hidden / sm:block breakpoint).
    assert.doesNotMatch(wrapper.props.className, /(^|\s)(\w+:)?(hidden|block)(\s|$)/, wrapper.props.className);
  });

  it('the Control Pane sidebar uses the same shared picker', () => {
    // DashboardSidebar needs Next router hooks, so check its source instead of rendering it.
    const src = readFileSync(fileURLToPath(new URL('./dashboard-sidebar.tsx', import.meta.url)), 'utf8');
    assert.match(src, /import \{ CompanySwitcher[^}]*\} from '@\/components\/company-switcher'/);
    assert.match(src, /<CompanySwitcher companies=\{companies\} activeCompanyId=\{activeCompanyId\} \/>/);
    const shellSrc = readFileSync(fileURLToPath(new URL('./assistant/assistant-shell.tsx', import.meta.url)), 'utf8');
    assert.match(shellSrc, /from '@\/components\/company-switcher'/);
  });

  // ---- B1: one trigger width, tied to the real Control Pane sidebar width ----

  /** Resolve `14rem`, `3px` or `calc(a + b + ...)` (rem/px terms only) to px at 16px/rem. */
  function toPx(css: string): number {
    const inner = css.trim().replace(/^calc\((.*)\)$/, '$1');
    return inner.split('+').reduce((sum, term) => {
      const m = term.trim().match(/^(\d+(?:\.\d+)?)(rem|px)$/);
      assert.ok(m, `unsupported length term: ${term}`);
      return sum + Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
    }, 0);
  }

  it('the picker trigger is 14rem (224px) and sets that width itself', () => {
    assert.equal(mod.COMPANY_SWITCHER_WIDTH, '14rem');
    assert.equal(toPx(mod.COMPANY_SWITCHER_WIDTH), 224);
    const trigger = view().els.find((e) => e.type === ui.SelectTrigger)!;
    assert.equal(trigger.props.style?.width, mod.COMPANY_SWITCHER_WIDTH);
    assert.doesNotMatch(trigger.props.className, /(^|\s)(min-|max-)?w-/, trigger.props.className);
    const html = renderToStaticMarkup(React.createElement(mod.CompanySwitcherView, view().props));
    assert.match(html, /data-company-switcher-trigger="true"[^>]*style="width:14rem"/);
  });

  it('the Control Pane sidebar width comes from the picker width and fits it exactly', () => {
    const tree = (dash.DashboardShell as (p: unknown) => React.ReactNode)({
      companies,
      activeCompanyId: companies[0].id,
      activeCompanyName: 'Acme',
      buildInfo: {},
      children: null,
    });
    const provider = walk(tree).find((e) => e.type === sidebarUi.SidebarProvider);
    assert.ok(provider, 'DashboardShell renders SidebarProvider');
    const sidebarWidth = provider.props.style['--sidebar-width'];
    assert.equal(sidebarWidth, mod.CONTROL_PANE_SIDEBAR_WIDTH);

    // Inner width the picker gets in the sidebar header: sidebar width minus the header's
    // horizontal padding and the container's 1px border.
    const header = renderToStaticMarkup(React.createElement(sidebarUi.SidebarHeader));
    const pad = header.match(/class="[^"]*\bp-(\d+(?:\.\d+)?)\b/);
    assert.ok(pad, header);
    const headerPadPx = 2 * Number(pad[1]) * 4; // Tailwind spacing: 0.25rem = 4px
    const borderPx = 1;
    assert.equal(toPx(mod.SIDEBAR_HEADER_INSET), headerPadPx + borderPx);

    // The picker wrapper adds no horizontal padding of its own.
    const wrapper = view().tree;
    assert.doesNotMatch(wrapper.props.className, /(^|\s)p[xlrse]?-/, wrapper.props.className);

    const innerPx = toPx(sidebarWidth) - headerPadPx - borderPx;
    assert.equal(innerPx, toPx(mod.COMPANY_SWITCHER_WIDTH));
    assert.equal(innerPx, 224);
  });

  // ---- S1: hidden when the Control Pane sidebar is collapsed to icons ----

  it('hides the whole picker when the sidebar is collapsed to icons', () => {
    const { tree } = view();
    assert.equal(tree.props['data-company-switcher'], true);
    assert.ok(tree.props.className.split(' ').includes('group-data-[collapsible=icon]:hidden'), tree.props.className);
    const html = renderToStaticMarkup(React.createElement(mod.CompanySwitcherView, view().props));
    assert.match(html, /^<div class="[^"]*group-data-\[collapsible=icon\]:hidden[^"]*" data-company-switcher="true">/);
  });

  // ---- S3 / S4: RTL names and aligned prefixes ----

  it('names use dir="auto" so right-to-left names truncate from their own end', () => {
    const rtl = [{ id: '33333333-3333-4333-8333-333333333333', name: 'شركة ذات اسم طويل جدا جدا', issuePrefix: 'RTL' }];
    const { els } = view({ companies: rtl, activeCompanyId: rtl[0].id });
    const names = els.filter((e) => e.type === 'span' && e.props.title === rtl[0].name);
    assert.equal(names.length, 2, 'trigger label and dropdown name');
    for (const n of names) {
      assert.equal(n.props.dir, 'auto');
      assert.match(n.props.className, /\btext-start\b/);
      assert.doesNotMatch(n.props.className, /\btext-left\b/);
    }
  });

  it('dropdown prefixes are pushed to one right-aligned column', () => {
    const { els } = view();
    const items = els.filter((e) => e.type === ui.SelectItem && e.props.value !== mod.NEW_COMPANY_VALUE);
    for (const [i, item] of items.entries()) {
      const kids = walk(item.props.children);
      const name = kids.find((e) => e.props.title === companies[i].name)!;
      const prefix = kids.find((e) => e.props['data-company-switcher-prefix'] !== undefined)!;
      assert.equal(prefix.props.children, companies[i].issuePrefix);
      assert.ok(name.props.className.split(' ').includes('flex-1'), name.props.className);
      for (const c of ['ml-auto', 'shrink-0', 'text-right']) {
        assert.ok(prefix.props.className.split(' ').includes(c), `${c} in ${prefix.props.className}`);
      }
    }
  });

  // ---- S2 / S5: switching wiring and failure recovery ----

  function fakeDeps(sync: (id: string) => Promise<unknown> = async () => undefined) {
    const log: string[] = [];
    const errors: unknown[] = [];
    const deps = {
      setStoredCompanyId: (id: string) => log.push(`store:${id}`),
      syncActiveCompany: async (id: string) => {
        log.push(`sync:${id}`);
        return sync(id);
      },
      refresh: () => log.push('refresh'),
      setSwitching: (v: boolean) => log.push(`switching:${v}`),
      openCreate: () => log.push('create'),
      onError: (e: unknown) => errors.push(e),
    };
    return { log, errors, deps };
  }
  const flush = () => new Promise((r) => setImmediate(r));

  it('switchActiveCompany stores, syncs, refreshes, then re-enables the picker', async () => {
    const { log, deps } = fakeDeps();
    const done = await mod.switchActiveCompany('b', { activeCompanyId: 'a', switching: false }, deps);
    assert.equal(done, true);
    assert.deepEqual(log, ['switching:true', 'store:b', 'sync:b', 'refresh', 'switching:false']);
  });

  it('switchActiveCompany ignores the active company and a switch already running', async () => {
    const { log, deps } = fakeDeps();
    assert.equal(await mod.switchActiveCompany('a', { activeCompanyId: 'a', switching: false }, deps), false);
    assert.equal(await mod.switchActiveCompany('b', { activeCompanyId: 'a', switching: true }, deps), false);
    assert.deepEqual(log, []);
  });

  it('a failed switch re-enables the picker and reports the error', async () => {
    const boom = new Error('sync failed');
    const { log, deps } = fakeDeps(async () => {
      throw boom;
    });
    await assert.rejects(mod.switchActiveCompany('b', { activeCompanyId: 'a', switching: false }, deps), boom);
    assert.deepEqual(log, ['switching:true', 'store:b', 'sync:b', 'switching:false']);

    const h = fakeDeps(async () => {
      throw boom;
    });
    mod.companySwitcherHandlers({ activeCompanyId: 'a', switching: false }, h.deps).onSelect('b');
    await flush();
    assert.deepEqual(h.log, ['switching:true', 'store:b', 'sync:b', 'switching:false']);
    assert.deepEqual(h.errors, [boom]);
  });

  it('companySwitcherHandlers: onSelect switches company, onCreate opens the create dialog', async () => {
    const { log, errors, deps } = fakeDeps();
    const h = mod.companySwitcherHandlers({ activeCompanyId: 'a', switching: false }, deps);
    h.onSelect('b');
    await flush();
    assert.deepEqual(log, ['switching:true', 'store:b', 'sync:b', 'refresh', 'switching:false']);
    h.onCreate();
    assert.deepEqual(log.slice(-1), ['create']);
    assert.deepEqual(errors, []);
  });

  it('CompanySwitcher wires the view to companySwitcherHandlers and the real actions', () => {
    // CompanySwitcher needs the Next router, so check the wiring in its source.
    const src = readFileSync(fileURLToPath(new URL('./company-switcher.tsx', import.meta.url)), 'utf8');
    const body = src.slice(src.indexOf('export function CompanySwitcher('));
    assert.match(body, /companySwitcherHandlers\(\s*\{ activeCompanyId, switching \}/);
    assert.match(body, /syncActiveCompany: syncActiveCompanyAction/);
    assert.match(body, /refresh: \(\) => router\.refresh\(\)/);
    assert.match(body, /openCreate: \(\) => setCreateOpen\(true\)/);
    assert.match(body, /disabled=\{switching\}/);
    assert.match(body, /onSelect=\{handlers\.onSelect\}/);
    assert.match(body, /onCreate=\{handlers\.onCreate\}/);
  });
});
