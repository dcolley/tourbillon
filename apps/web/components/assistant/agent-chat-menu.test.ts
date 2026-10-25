/**
 * ASYNC-0: the agent chat ⋯ menu and the Clear chat confirm, plus the chat chrome slot.
 * Slice B: the confirm warns about a waiting card; AgentChat stops it before clearing.
 * Rendered with react-dom/server (the repo has no DOM test library).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

type MenuMod = typeof import('./agent-chat-menu');
let ClearChatConfirmView: MenuMod['ClearChatConfirmView'];
let AgentChatMenu: MenuMod['AgentChatMenu'];
let AgentChatView: typeof import('./agent-chat')['AgentChatView'];
let initialAgentChatState: typeof import('../../lib/agui/client/chat-state')['initialAgentChatState'];
let Button: typeof import('@/components/ui/button')['Button'];

before(async () => {
  (globalThis as { React?: unknown }).React = React;
  ({ ClearChatConfirmView, AgentChatMenu } = await import('./agent-chat-menu'));
  ({ AgentChatView } = await import('./agent-chat'));
  ({ initialAgentChatState } = await import('../../lib/agui/client/chat-state'));
  ({ Button } = await import('@/components/ui/button'));
});

/** Expand plain function components (not Button) and collect Buttons. */
function buttons(node: React.ReactNode, out: React.ReactElement<Record<string, unknown>>[] = []) {
  if (Array.isArray(node)) {
    for (const n of node) buttons(n, out);
    return out;
  }
  if (!React.isValidElement(node)) return out;
  const el = node as React.ReactElement<Record<string, unknown>>;
  if (el.type === Button) out.push(el);
  else if (typeof el.type === 'function') return buttons((el.type as (p: unknown) => React.ReactNode)(el.props), out);
  buttons(el.props.children as React.ReactNode, out);
  return out;
}
const text = (el: React.ReactElement<Record<string, unknown>>) => String(el.props.children);

describe('ASYNC-0 agent chat menu', () => {
  it('confirm: explains the clear, Cancel and Clear chat call back', () => {
    const calls: string[] = [];
    const el = React.createElement(ClearChatConfirmView, {
      busy: false,
      error: null,
      onConfirm: () => calls.push('confirm'),
      onCancel: () => calls.push('cancel'),
    });
    const html = renderToStaticMarkup(el);
    assert.match(html, /fresh conversation/);
    assert.doesNotMatch(html, /data-clear-chat-error/);
    const [cancel, clear] = buttons(el);
    assert.deepEqual([text(cancel), text(clear)], ['Cancel', 'Clear chat']);
    (cancel.props.onClick as () => void)();
    (clear.props.onClick as () => void)();
    assert.deepEqual(calls, ['cancel', 'confirm']);
  });

  it('confirm: busy disables both buttons; an error shows as an alert', () => {
    const noop = () => {};
    const el = React.createElement(ClearChatConfirmView, { busy: true, error: 'Too many new threads', onConfirm: noop, onCancel: noop });
    const html = renderToStaticMarkup(el);
    assert.match(html, /role="alert"[^>]*data-clear-chat-error[^>]*>Too many new threads/);
    const bs = buttons(el);
    assert.ok(bs.every((b) => b.props.disabled === true));
    assert.equal(text(bs[1]), 'Clearing…');
  });

  it('confirm: a waiting card is named and the user is told Clear stops it (Slice B)', () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      React.createElement(ClearChatConfirmView, { busy: false, error: null, pendingCard: 'form card (“Setup”)', onConfirm: noop, onCancel: noop }),
    );
    assert.match(html, /data-clear-chat-pending[^>]*>The form card \(“Setup”\) is still waiting for your answer\. Clearing stops it/);
    const none = renderToStaticMarkup(React.createElement(ClearChatConfirmView, { busy: false, error: null, onConfirm: noop, onCancel: noop }));
    assert.doesNotMatch(none, /data-clear-chat-pending/);
  });

  it('menu trigger renders as "Chat options" (items open on click)', () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentChatMenu, { agentUrlKey: 'ceo', runOpen: false, onClear: async () => ({ ok: true as const, threadId: 't' }) }),
    );
    assert.match(html, /aria-label="Chat options"/);
    assert.match(html, /data-chat-menu/);
    assert.doesNotMatch(html, /New chat/);
  });

  it('chat view renders the ⋯ menu in the chat chrome above the messages', () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      React.createElement(AgentChatView, {
        phase: 'ready',
        setupError: null,
        state: { ...initialAgentChatState, items: [{ kind: 'assistant', id: 'a1', text: 'Hello!', streaming: false }] },
        draft: '',
        onDraftChange: noop,
        onSend: noop,
        onSteer: noop,
        onStop: noop,
        onToolDecision: noop,
        onDismissError: noop,
        chatMenu: React.createElement('button', { 'data-test-menu': true }, '⋯'),
      }),
    );
    const chrome = html.indexOf('data-chat-chrome');
    assert.ok(chrome > -1 && chrome < html.indexOf('data-test-menu') && html.indexOf('data-test-menu') < html.indexOf('Hello!'), html);
    // No chrome without either slot.
    const bare = renderToStaticMarkup(
      React.createElement(AgentChatView, {
        phase: 'ready',
        setupError: null,
        state: initialAgentChatState,
        draft: '',
        onDraftChange: noop,
        onSend: noop,
        onSteer: noop,
        onStop: noop,
        onToolDecision: noop,
        onDismissError: noop,
      }),
    );
    assert.doesNotMatch(bare, /data-chat-chrome/);
  });

  it('AgentChat wires the menu to Clear chat and has no New chat', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const src = await readFile(fileURLToPath(new URL('./agent-chat.tsx', import.meta.url)), 'utf8');
    assert.match(src, /<AgentChatMenu/);
    assert.match(src, /clearAgentChat\(agentId/);
    // Slice B: the menu gets the OM mode and the waiting card; a parked run is stopped before clearing.
    assert.match(src, /observationalMemory=\{observationalMemory\}/);
    assert.match(src, /pendingCard=\{pendingCardDescription\(parkedNow\)\}/);
    assert.ok(src.indexOf('await chat.abort()') > -1 && src.indexOf('await chat.abort()') < src.indexOf('await clearAgentChat(agentId)'));
    assert.doesNotMatch(src, />New chat<|'New chat'|newThread\(/);
  });
});
