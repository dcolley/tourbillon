/**
 * UX-1: PasswordInput show/hide toggle.
 * The repo has no DOM test library (no jsdom/testing-library), so this uses what it already has:
 * react-dom/server markup for the rendered component, and the stateless PasswordInputView's element
 * tree for wiring (button type, aria-*, onClick, prop/ref passthrough).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

type El = React.ReactElement<Record<string, any>>;

describe('UX-1 PasswordInput', () => {
  let PasswordInput: (p: Record<string, unknown>) => React.ReactNode;
  let PasswordInputView: (p: Record<string, unknown>) => El;

  before(async () => {
    // tsx compiles JSX with the classic runtime (tsconfig jsx: preserve).
    (globalThis as { React?: unknown }).React = React;
    ({ PasswordInput, PasswordInputView } = (await import('./password-input')) as never);
  });

  const parts = (el: El) => {
    const [input, button] = React.Children.toArray(el.props.children) as El[];
    return { input, button };
  };

  it('is hidden by default: type=password, "Show secret", aria-pressed=false', () => {
    const html = renderToStaticMarkup(React.createElement(PasswordInput, { id: 'k', defaultValue: 'x' }));
    assert.match(html, /<input[^>]*type="password"/);
    assert.match(html, /<button[^>]*type="button"/);
    assert.match(html, /aria-label="Show secret"/);
    assert.match(html, /aria-pressed="false"/);
    assert.doesNotMatch(html, /type="text"/);
  });

  it('toggle button: real type=button (never submits), label and aria-pressed follow the state', () => {
    const hidden = parts(PasswordInputView({ visible: false, onToggleVisible: () => {} }));
    assert.equal(hidden.input.type, 'input');
    assert.equal(hidden.input.props.type, 'password');
    assert.equal(hidden.button.type, 'button');
    assert.equal(hidden.button.props.type, 'button');
    assert.equal(hidden.button.props['aria-label'], 'Show secret');
    assert.equal(hidden.button.props['aria-pressed'], false);

    const shown = parts(PasswordInputView({ visible: true, onToggleVisible: () => {} }));
    assert.equal(shown.input.props.type, 'text');
    assert.equal(shown.button.props['aria-label'], 'Hide secret');
    assert.equal(shown.button.props['aria-pressed'], true);
  });

  it('clicking the button toggles visibility (hidden → shown → hidden)', () => {
    let visible = false;
    const render = () => parts(PasswordInputView({ visible, onToggleVisible: () => { visible = !visible; } }));
    let p = render();
    assert.equal(p.input.props.type, 'password');
    p.button.props.onClick();
    p = render();
    assert.equal(p.input.props.type, 'text');
    assert.equal(p.button.props['aria-label'], 'Hide secret');
    p.button.props.onClick();
    p = render();
    assert.equal(p.input.props.type, 'password');
    assert.equal(p.button.props['aria-label'], 'Show secret');
  });

  it('passes input props and ref through, ignores a caller-supplied type, and keeps the value off the button', () => {
    const ref = React.createRef<HTMLInputElement>();
    const onChange = () => {};
    const { input, button } = parts(
      PasswordInputView({
        visible: false,
        onToggleVisible: () => {},
        ref,
        id: 'api-key',
        name: 'apiKey',
        value: 'sk-test-value',
        onChange,
        placeholder: 'Enter API key',
        autoComplete: 'off',
        required: true,
        disabled: false,
        className: 'my-input',
        type: 'text',
      }),
    );
    assert.equal(input.props.ref, ref);
    assert.equal(input.props.id, 'api-key');
    assert.equal(input.props.name, 'apiKey');
    assert.equal(input.props.value, 'sk-test-value');
    assert.equal(input.props.onChange, onChange);
    assert.equal(input.props.placeholder, 'Enter API key');
    assert.equal(input.props.required, true);
    assert.equal(input.props.type, 'password', 'visibility state wins over a passed type');
    assert.match(input.props.className, /my-input/);
    assert.equal(button.props['aria-controls'], 'api-key');
    assert.ok(!JSON.stringify(Object.keys(button.props)).includes('value'));
  });

  it('disabled input also disables the toggle', () => {
    const { button } = parts(PasswordInputView({ visible: false, onToggleVisible: () => {}, disabled: true }));
    assert.equal(button.props.disabled, true);
  });

  it('never logs the value', () => {
    const calls: unknown[] = [];
    const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => { calls.push(a); };
    try {
      renderToStaticMarkup(React.createElement(PasswordInput, { defaultValue: 'super-secret-0001' }));
      parts(PasswordInputView({ visible: true, onToggleVisible: () => {}, value: 'super-secret-0001', onChange: () => {} }));
    } finally {
      Object.assign(console, orig);
    }
    assert.ok(!JSON.stringify(calls).includes('super-secret-0001'));
  });
});
