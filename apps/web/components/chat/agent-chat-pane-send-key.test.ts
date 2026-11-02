/**
 * S296-S5: DOM-level pin for the Control-Pane composer keydown (behavioural complement to the
 * source-level regex row in lib/chat-send-key-wiring.test.ts, so mutating the pane's handler is
 * caught by behaviour, not just by one regex).
 *
 * Same idiom as agent-chat-send-key.test.ts / password-input.test.ts (the repo has no DOM test
 * library): the pane's ChatPaneBody is rendered with react-dom/server, the element tree is
 * captured at createElement, and the textarea's onKeyDown is driven directly. The session hook,
 * the preference hook and the header menu are stubbed by swapping the compiled module exports
 * before the pane is imported (mock.module is ESM-only; tsx runs these tests as CJS), so the
 * pane's OWN handler code is what runs: mode branching, the S296-S4 empty-draft swallow, and the
 * send / steer routing.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatSendKeyMode } from '@/lib/chat-send-key';

type El = React.ReactElement<Record<string, any>>;

interface PaneStub {
  mode: ChatSendKeyMode;
  input: string;
  running: boolean;
  connecting: boolean;
  sends: string[];
  steers: string[];
}

const stub: PaneStub = {
  mode: 'enter_sends',
  input: '',
  running: false,
  connecting: false,
  sends: [],
  steers: [],
};

function reset(next: Partial<Pick<PaneStub, 'mode' | 'input' | 'running'>> = {}) {
  stub.mode = next.mode ?? 'enter_sends';
  stub.input = next.input ?? '';
  stub.running = next.running ?? false;
  stub.connecting = false;
  stub.sends = [];
  stub.steers = [];
}

function makeSession() {
  return {
    threads: [],
    threadId: null,
    messages: [],
    running: stub.running,
    connecting: stub.connecting,
    error: null,
    pendingApproval: null,
    input: stub.input,
    setInput: () => {},
    selectThread: async () => {},
    newThread: async () => {},
    renameThread: async () => {},
    deleteThread: async () => {},
    sendMessage: async (text: string) => {
      stub.sends.push(text);
    },
    abort: async () => {},
    steer: async (text: string) => {
      stub.steers.push(text);
    },
    respondApproval: async () => {},
    activeAgentId: 'agent-1',
    activeAgentName: 'Test Agent',
    agentOptions: [],
    switchAgent: async () => {},
  };
}

const req = createRequire(import.meta.url);

/**
 * tsx compiles these modules to CJS whose exports are non-configurable getters, so the seams are
 * replaced by injecting ready-made exports into the require cache before the pane first loads.
 */
function stubModule(spec: string, exportsValue: Record<string, unknown>) {
  const cache = (req('node:module') as { Module: { _cache: Record<string, unknown> } }).Module._cache;
  const filename = req.resolve(spec);
  cache[filename] = { id: filename, filename, loaded: true, exports: exportsValue };
}

describe('S296-S5 Control-Pane composer keydown (DOM level)', () => {
  let ChatPaneBody: (p: Record<string, unknown>) => React.ReactNode;
  let lastCapture: El[] = [];

  before(async () => {
    // Stub the pane's seams (the session, the preference hook, and the header menu) before the
    // pane is first loaded; the pane reads them as module properties at call time.
    stubModule('./use-agent-chat-session', {
      useAgentChatSession: () => makeSession(),
      chatMessagePlainText: (m: { content?: { parts?: Array<{ type: string; text?: string }> } }) =>
        (m.content?.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n'),
      isChatUserMessage: (m: { role: string }) => m.role === 'user',
      formatChatMessageDateTime: (m: { createdAt?: string }) => m.createdAt ?? null,
    });
    stubModule('./use-chat-send-key-mode', {
      useChatSendKeyMode: () => [stub.mode, () => {}],
    });
    stubModule('./chat-send-key-menu', {
      ChatSendKeyMenu: () => null,
    });

    // tsx compiles JSX with the classic runtime (tsconfig jsx: preserve): agent-chat-pane.tsx
    // resolves React.createElement from the global, so wrapping it captures the element tree.
    (globalThis as { React?: unknown }).React = new Proxy(React, {
      get(target, prop) {
        if (prop === 'createElement') {
          return (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => {
            const el = React.createElement(type as never, props as never, ...(children as never[]));
            lastCapture.push(el);
            return el;
          };
        }
        return Reflect.get(target, prop);
      },
    });
    ({ ChatPaneBody } = (await import('./agent-chat-pane')) as never);
  });

  function composerTextarea(): El {
    lastCapture = [];
    renderToStaticMarkup(
      React.createElement(ChatPaneBody, {
        agentName: 'Test Agent',
        contextType: 'free',
        session: makeSession(),
        bottomRef: { current: null },
        layoutMode: 'popover',
        onLayoutModeChange: () => {},
      }),
    );
    const el = lastCapture.find((e) => e.type === 'textarea');
    assert.ok(el, 'the pane composer textarea is rendered');
    return el!;
  }

  /** Drive a keydown; returns whether the handler preventDefault-ed it. */
  function press(el: El, event: Record<string, unknown>): boolean {
    let prevented = false;
    el.props.onKeyDown({ preventDefault: () => (prevented = true), nativeEvent: {}, ...event });
    return prevented;
  }

  it('enter_sends, empty draft: Enter is swallowed (no send, no newline); non-send chords reach the textarea', () => {
    reset({ mode: 'enter_sends', input: '' });
    const el = composerTextarea();
    assert.equal(press(el, { key: 'Enter' }), true, 'S296-S4: the send chord is swallowed even when empty');
    assert.equal(press(el, { key: 'Enter', shiftKey: true }), false, 'Shift+Enter stays a newline');
    for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      assert.equal(press(el, { key: 'Enter', [mod]: true }), false, `${mod}+Enter is left alone when idle`);
    }
    assert.equal(press(el, { key: 'a' }), false);
    assert.deepEqual([stub.sends, stub.steers], [[], []], 'swallowing must not fire a send or a steer');
  });

  it('enter_sends, with text: Enter sends the draft; Shift+Enter stays a newline', () => {
    reset({ mode: 'enter_sends', input: 'hello pane' });
    const el = composerTextarea();
    assert.equal(press(el, { key: 'Enter', shiftKey: true }), false);
    assert.deepEqual(stub.sends, [], 'Shift+Enter never sends');
    assert.equal(press(el, { key: 'Enter' }), true);
    assert.deepEqual(stub.sends, ['hello pane'], 'send goes through sendMessage with the draft');
    assert.deepEqual(stub.steers, []);
  });

  it('mod_enter_sends, empty draft: Enter writes a newline; Ctrl/Cmd+Enter is swallowed without a send', () => {
    reset({ mode: 'mod_enter_sends', input: '' });
    const el = composerTextarea();
    assert.equal(press(el, { key: 'Enter' }), false, 'plain Enter must reach the textarea as a newline');
    assert.equal(press(el, { key: 'Enter', altKey: true }), false, 'Alt is not the send gesture');
    assert.equal(press(el, { key: 'Enter', metaKey: true }), true, 'S296-S4: the send chord is swallowed even when empty');
    assert.equal(press(el, { key: 'Enter', ctrlKey: true }), true);
    assert.deepEqual([stub.sends, stub.steers], [[], []], 'swallowing must not fire a send or a steer');
  });

  it('mod_enter_sends, with text: Enter stays a newline, Ctrl/Cmd+Enter sends', () => {
    reset({ mode: 'mod_enter_sends', input: 'mod enter' });
    const el = composerTextarea();
    assert.equal(press(el, { key: 'Enter' }), false, 'Enter is a newline in mod mode');
    assert.deepEqual(stub.sends, [], 'Enter does not send in mod mode');
    assert.equal(press(el, { key: 'Enter', ctrlKey: true }), true, 'Ctrl+Enter on Windows/Linux');
    assert.deepEqual(stub.sends, ['mod enter']);
    assert.equal(press(el, { key: 'Enter', metaKey: true }), true, 'Cmd+Enter on macOS');
    assert.deepEqual(stub.sends, ['mod enter', 'mod enter']);
  });

  it('run open: Enter queues through sendMessage, Ctrl+Enter steers; with an empty draft both are swallowed silently', () => {
    reset({ mode: 'enter_sends', input: 'queue me', running: true });
    const el = composerTextarea();
    assert.equal(press(el, { key: 'Enter' }), true, 'Enter queues the follow-up (through sendMessage)');
    assert.deepEqual(stub.sends, ['queue me']);
    assert.equal(press(el, { key: 'Enter', ctrlKey: true }), true, 'the shipped Ctrl+Enter steer gesture survives');
    assert.deepEqual(stub.steers, ['queue me']);

    reset({ mode: 'enter_sends', input: '   ', running: true });
    const empty = composerTextarea();
    assert.equal(press(empty, { key: 'Enter' }), true, 'S296-S4: whitespace-only Enter is swallowed too');
    assert.equal(press(empty, { key: 'Enter', ctrlKey: true }), true, 'S296-S4: whitespace-only Ctrl+Enter is swallowed too');
    assert.deepEqual([stub.sends, stub.steers], [[], []], 'nothing to send or steer');
  });

  it('IME composition is never swallowed, in either mode', () => {
    for (const mode of ['enter_sends', 'mod_enter_sends'] as const) {
      reset({ mode, input: 'composing' });
      const el = composerTextarea();
      assert.equal(press(el, { key: 'Enter', isComposing: true }), false, mode);
      assert.equal(press(el, { key: 'Enter', metaKey: true, nativeEvent: { isComposing: true } }), false, mode);
      assert.deepEqual([stub.sends, stub.steers], [[], []], mode);
    }
  });
});
