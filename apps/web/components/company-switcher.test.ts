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

  before(async () => {
    // tsx compiles JSX with the classic runtime (tsconfig jsx: preserve).
    (globalThis as { React?: unknown }).React = React;
    mod = await import('./company-switcher');
    ui = await import('@/components/ui/select');
    shell = await import('./assistant/assistant-shell');
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
    const label = html.match(/<span class="([^"]*)" title="([^"]*)">([^<]*)<\/span>/);
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

  it('the Assistant view uses the shared picker at the Control Pane width', () => {
    const tree = (shell.AssistantShell as (p: unknown) => React.ReactNode)({
      companies,
      activeCompanyId: companies[0].id,
      activeCompanyName: 'Acme',
      children: null,
    });
    const els = walk(tree);
    const picker = els.find((e) => e.type === mod.CompanySwitcher);
    assert.ok(picker, 'AssistantShell renders CompanySwitcher');
    const wrapper = els.find((e) => walk(e.props.children).includes(picker!) && /\bsm:block\b/.test(e.props.className ?? ''));
    assert.ok(wrapper);
    assert.ok(wrapper.props.className.split(' ').includes(mod.COMPANY_SWITCHER_WIDTH_CLASS), wrapper.props.className);
  });

  it('the Control Pane sidebar uses the same shared picker', () => {
    // DashboardSidebar needs Next router hooks, so check its source instead of rendering it.
    const src = readFileSync(fileURLToPath(new URL('./dashboard-sidebar.tsx', import.meta.url)), 'utf8');
    assert.match(src, /import \{ CompanySwitcher[^}]*\} from '@\/components\/company-switcher'/);
    assert.match(src, /<CompanySwitcher companies=\{companies\} activeCompanyId=\{activeCompanyId\} \/>/);
    const shellSrc = readFileSync(fileURLToPath(new URL('./assistant/assistant-shell.tsx', import.meta.url)), 'utf8');
    assert.match(shellSrc, /from '@\/components\/company-switcher'/);
  });
});
