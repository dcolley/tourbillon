/**
 * CHAT-SEND-KEY on the assistant chat composer (agent-chat.tsx). No DOM library in the repo: the
 * stateless view is rendered as an element tree and the textarea's onKeyDown is driven directly, so
 * the binding the user gets is the one under test (send / steer / newline per mode, plus the hint).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initialAgentChatState, type AgentChatState } from '../../lib/agui/client/chat-state';
import type { ChatSendKeyMode } from '@/lib/chat-send-key';

type View = typeof import('./agent-chat');
let AgentChatView: View['AgentChatView'];

type El = React.ReactElement<Record<string, any>>;

interface CallLog {
  sends: number;
  steers: number;
}

function makeProps(
  log: CallLog,
  state: Partial<AgentChatState> = {},
  extra: Partial<Parameters<View['AgentChatView']>[0]> = {},
) {
  return {
    phase: 'ready' as const,
    setupError: null,
    state: { ...initialAgentChatState, ...state },
    draft: extra.draft ?? '',
    onDraftChange: () => {},
    onSend: () => {
      log.sends += 1;
    },
    onSteer: () => {
      log.steers += 1;
    },
    onStop: () => {},
    onToolDecision: () => {},
    onDismissError: () => {},
    ...extra,
  };
}

function collect(node: React.ReactNode, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => collect(n, out));
  else if (React.isValidElement(node)) {
    out.push(node as El);
    collect((node as El).props.children, out);
  }
  return out;
}

function composerTextarea(node: React.ReactNode): El {
  const el = collect(node).find((e) => e.type === 'textarea' && e.props['aria-label'] === 'Message');
  assert.ok(el, 'the composer textarea is rendered');
  return el!;
}

/** Drive a keydown; returns whether the handler preventDefault-ed it. */
function press(el: El, event: Record<string, unknown>): boolean {
  let prevented = false;
  el.props.onKeyDown({ preventDefault: () => (prevented = true), nativeEvent: {}, ...event });
  return prevented;
}

describe('CHAT-SEND-KEY assistant composer', () => {
  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    ({ AgentChatView } = await import('./agent-chat'));
  });

  it('enter_sends (default): Enter sends, Shift+Enter and any modified Enter do not', () => {
    const log: CallLog = { sends: 0, steers: 0 };
    const view = AgentChatView(makeProps(log, {}, { draft: 'hello' }));
    const el = composerTextarea(view);

    assert.equal(press(el, { key: 'a' }), false);
    assert.equal(press(el, { key: 'Enter', shiftKey: true }), false, 'Shift+Enter is a newline');
    for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      assert.equal(press(el, { key: 'Enter', [mod]: true }), false, `${mod}+Enter is left alone`);
    }
    assert.deepEqual(log, { sends: 0, steers: 0 }, 'the wrong combo never sends');

    assert.equal(press(el, { key: 'Enter' }), true);
    assert.deepEqual(log, { sends: 1, steers: 0 });
  });

  it('mod_enter_sends: Enter writes a newline, Ctrl/Cmd+Enter sends', () => {
    const log: CallLog = { sends: 0, steers: 0 };
    const view = AgentChatView(makeProps(log, {}, { draft: 'hello', sendKeyMode: 'mod_enter_sends' }));
    const el = composerTextarea(view);

    assert.equal(press(el, { key: 'Enter' }), false, 'Enter must reach the textarea as a newline');
    assert.equal(press(el, { key: 'Enter', altKey: true }), false, 'Alt is not the send gesture');
    assert.deepEqual(log, { sends: 0, steers: 0 });

    assert.equal(press(el, { key: 'Enter', metaKey: true }), true, 'Cmd+Enter on macOS');
    assert.deepEqual(log, { sends: 1, steers: 0 });
    assert.equal(press(el, { key: 'Enter', ctrlKey: true }), true, 'Ctrl+Enter on Windows/Linux');
    assert.deepEqual(log, { sends: 2, steers: 0 });
  });

  it('both modes: a modified Enter steers an open run, Enter only queues in enter_sends', () => {
    const enterLog: CallLog = { sends: 0, steers: 0 };
    const enterView = composerTextarea(
      AgentChatView(makeProps(enterLog, { status: 'running' }, { draft: 'left' })),
    );
    assert.equal(press(enterView, { key: 'Enter' }), true, 'Enter queues the follow-up');
    assert.deepEqual(enterLog, { sends: 1, steers: 0 }, 'the container routes it through onSend');
    assert.equal(press(enterView, { key: 'Enter', ctrlKey: true }), true);
    assert.deepEqual(enterLog, { sends: 1, steers: 1 });

    const modLog: CallLog = { sends: 0, steers: 0 };
    const modView = composerTextarea(
      AgentChatView(makeProps(modLog, { status: 'running' }, { draft: 'left', sendKeyMode: 'mod_enter_sends' })),
    );
    assert.equal(press(modView, { key: 'Enter' }), false, 'Enter stays a newline while a run is open');
    assert.deepEqual(modLog, { sends: 0, steers: 0 });
    assert.equal(press(modView, { key: 'Enter', metaKey: true }), true);
    assert.deepEqual(modLog, { sends: 0, steers: 1 });
  });

  it('IME composition is never a send, in either mode', () => {
    for (const mode of ['enter_sends', 'mod_enter_sends'] as const) {
      const log: CallLog = { sends: 0, steers: 0 };
      const el = composerTextarea(AgentChatView(makeProps(log, {}, { draft: 'x', sendKeyMode: mode })));
      assert.equal(press(el, { key: 'Enter', isComposing: true }), false, mode);
      assert.equal(press(el, { key: 'Enter', metaKey: true, nativeEvent: { isComposing: true } }), false, mode);
      assert.deepEqual(log, { sends: 0, steers: 0 }, mode);
    }
  });

  it('nothing to send: Enter is not swallowed while the composer is empty', () => {
    const log: CallLog = { sends: 0, steers: 0 };
    const el = composerTextarea(AgentChatView(makeProps(log)));
    assert.equal(press(el, { key: 'Enter' }), false);
    assert.deepEqual(log, { sends: 0, steers: 0 });
  });

  it('the hint under the composer names the active key', () => {
    const log: CallLog = { sends: 0, steers: 0 };
    const htmlDefault = renderToStaticMarkup(
      React.createElement(AgentChatView, makeProps(log, {}, { draft: 'x' })),
    );
    assert.match(htmlDefault, /data-send-key-mode="enter_sends"[^>]*>Enter to send, Shift\+Enter for a new line</);
    const htmlMod = renderToStaticMarkup(
      React.createElement(AgentChatView, makeProps(log, {}, { draft: 'x', sendKeyMode: 'mod_enter_sends' })),
    );
    assert.match(htmlMod, /data-send-key-mode="mod_enter_sends"[^>]*>Ctrl\/Cmd\+Enter to send, Enter for a new line</);
    const htmlRunning = renderToStaticMarkup(
      React.createElement(
        AgentChatView,
        makeProps(log, { status: 'running' }, { draft: 'x', sendKeyMode: 'mod_enter_sends' }),
      ),
    );
    assert.match(htmlRunning, /Ctrl\/Cmd\+Enter steers, Enter for a new line/);
  });
});
