/**
 * UI-1: Assistant | Control Pane switcher. No DOM test library in the repo, so this checks
 * react-dom/server markup and the stateless view's element tree (like password-input.test.ts).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppView } from '@/lib/view-preference';

type El = React.ReactElement<Record<string, any>>;
type Mod = typeof import('./view-switcher');

describe('UI-1 ViewSwitcher', () => {
  let mod: Mod;

  before(async () => {
    // tsx compiles JSX with the classic runtime (tsconfig jsx: preserve).
    (globalThis as { React?: unknown }).React = React;
    mod = await import('./view-switcher');
  });

  const buttons = (current: AppView, onSelect: (v: AppView) => void = () => {}) => {
    const el = mod.ViewSwitcherView({ current, onSelect }) as El;
    return React.Children.toArray(el.props.children) as El[];
  };

  it('renders both views as buttons in a labelled group, Assistant first', () => {
    const html = renderToStaticMarkup(
      React.createElement(mod.ViewSwitcherView, { current: 'assistant', onSelect: () => {} }),
    );
    assert.match(html, /role="group"/);
    assert.match(html, /aria-label="View"/);
    const a = html.indexOf('Assistant');
    const c = html.indexOf('Control Pane');
    assert.ok(a > -1 && c > -1 && a < c);
    assert.equal((html.match(/<button[^>]*type="button"/g) ?? []).length, 2);
  });

  it('marks the current view with aria-pressed', () => {
    const onAssistant = buttons('assistant');
    assert.deepEqual(
      onAssistant.map((b) => [b.props['data-view'], b.props['aria-pressed']]),
      [
        ['assistant', true],
        ['control', false],
      ],
    );
    const onControl = buttons('control');
    assert.deepEqual(
      onControl.map((b) => [b.props['data-view'], b.props['aria-pressed']]),
      [
        ['assistant', false],
        ['control', true],
      ],
    );
  });

  it('clicking a button reports that view', () => {
    const picked: AppView[] = [];
    const [assistant, control] = buttons('assistant', (v) => picked.push(v));
    control.props.onClick();
    assistant.props.onClick();
    assert.deepEqual(picked, ['control', 'assistant']);
  });

  it('choosing the other view stores it and navigates to its landing page', () => {
    const writes: AppView[] = [];
    const paths: string[] = [];
    const deps = { write: (v: AppView) => writes.push(v), navigate: (p: string) => paths.push(p) };
    mod.selectAppView('control', 'assistant', deps);
    mod.selectAppView('assistant', 'control', deps);
    assert.deepEqual(writes, ['control', 'assistant']);
    assert.deepEqual(paths, ['/dashboard', '/assistant']);
  });

  it('choosing the current view does nothing', () => {
    let calls = 0;
    const deps = { write: () => void calls++, navigate: () => void calls++ };
    mod.selectAppView('assistant', 'assistant', deps);
    mod.selectAppView('control', 'control', deps);
    assert.equal(calls, 0);
  });
});
