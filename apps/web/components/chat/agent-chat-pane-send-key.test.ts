/**
 * S296-S5: DOM-level pin for the Control-Pane composer keydown (behavioural complement to the
 * source-level regex row in lib/chat-send-key-wiring.test.ts, so mutating the pane's handler is
 * caught by behaviour, not just by one regex).
 *
 * Same idiom as agent-chat-send-key.test.ts / password-input.test.ts (the repo has no DOM test
 * library): the pane's ChatPaneBody is rendered with react-dom/server, the element tree is
 * captured at createElement, and the textarea's onKeyDown is driven directly.
 *
 * S301-S1 (Refs #301): the session hook, the preference hook and the header menu are stubbed
 * through the pane module's exported `__test__` seam (read at call time, restored in after()),
 * instead of writing into the require cache — mock.module is ESM-only and tsx compiles these
 * tests to CJS, so the seam is the supported route. The pane's OWN handler code is what runs:
 * mode branching, the S296-S4 empty-draft swallow, and the send / steer routing.
 * S301-S2 (Refs #301): ChatPaneBody is no longer a named export; this file reaches it through the
 * seam, and the final test pins that no app host touches the test-only surface.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

describe('S296-S5 Control-Pane composer keydown (DOM level)', () => {
  let ChatPaneBody: (p: Record<string, unknown>) => React.ReactNode;
  let lastCapture: El[] = [];
  let restore: () => void = () => {};

  before(async () => {
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

    // S301-S1: swap the pane's live dependencies through the module's supported test seam. The
    // pane reads them at call time, and the seam entries are typed from the pane's imports, so a
    // renamed hook or import path is a compile error here (not a silent require-cache miss).
    const mod = await import('./agent-chat-pane');
    const seam = mod.__test__;
    const originals = { useChatSendKeyMode: seam.useChatSendKeyMode, ChatSendKeyMenu: seam.ChatSendKeyMenu };
    restore = () => Object.assign(seam, originals);
    // The session hook is NOT stubbed: ChatPaneBody receives the session as a prop, and the pure
    // message helpers run for real over the (empty) message list.
    seam.useChatSendKeyMode = () => [stub.mode, () => {}];
    seam.ChatSendKeyMenu = function ChatSendKeyMenuStub() {
      return React.createElement(React.Fragment);
    };

    ChatPaneBody = seam.ChatPaneBody as unknown as (p: Record<string, unknown>) => React.ReactNode;
  });

  after(() => restore());

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

  it('S301-S2: the test-only pane surface stays test-only (source pin)', () => {
    // ChatPaneBody is reached ONLY through the pane's __test__ seam, and only from this file:
    // hosts must render AgentChatPane. Scan every app source file (the same roots the test runner
    // walks, plus the root-level modules) for references to the private surface. Self-exempt: the
    // pane defines the seam and this file exercises it — the quoted specifier examples below would
    // otherwise make the pin flag itself.
    const root = fileURLToPath(new URL('../..', import.meta.url)); // apps/web
    const exempt = new Set([
      'components/chat/agent-chat-pane.tsx', // defines the seam
      'components/chat/agent-chat-pane-send-key.test.ts', // the only consumer of the pane seam
      // The container seam from S302-S1 shares the `__test__` name and is pinned to its own
      // consumer by these same rules there:
      'components/assistant/agent-chat.tsx',
      'components/assistant/agent-chat-avatar-header.test.ts',
    ]);
    const offenders: string[] = [];
    const check = (abs: string, relPath: string) => {
      if (exempt.has(relPath)) return;
      const src = readFileSync(abs, 'utf8');
      const touchesSeam =
        // the body name must never appear outside the pane / this test
        /\bChatPaneBody\b/.test(src) ||
        // the seam may only be pulled from the pane container modules
        (/\b__test__\b/.test(src) && /['"][^'"]*\/agent-chat(-pane)?['"]/.test(src));
      if (touchesSeam) offenders.push(relPath);
    };
    const walk = (dir: string, rel: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const abs = join(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(abs, relPath);
        else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) check(abs, relPath);
      }
    };
    for (const dir of ['app', 'components', 'lib']) walk(join(root, dir), dir);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if ((entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) && entry.isFile()) {
        check(join(root, entry.name), entry.name);
      }
    }
    assert.deepEqual(offenders, [], 'ChatPaneBody / __test__ stay test-only; hosts use AgentChatPane');
  });
});
