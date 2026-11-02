/**
 * S301-S3 (Refs #301): KEEP Enter silent while stopping — PM decision, pinned.
 *
 * While a chat run is in the `stopping` state, a send-key press in the assistant composer is
 * swallowed with NO feedback: no second send, no steer, no toast, and no composer "stopping"
 * hint. That silence is the decided behaviour (Test suggested a "stopping…" hint, PM kept it
 * silent), so a future change must not add a send/steer on the swallowed press or any press
 * feedback. The handler-side comment lives at the composer keydown in agent-chat.tsx.
 *
 * Idiom: same as agent-chat-send-key.test.ts — no DOM library; the stateless AgentChatView is
 * rendered to markup with react-dom/server and the textarea's onKeyDown is driven directly.
 * The view is stateless and takes `sendKeyMode` as a prop, so neither the container's test seam
 * (S302-S1) nor require-cache stubbing is needed here (S301-S1 rule: never Module._cache).
 *
 * Current behaviour pinned for the textarea value / newline (stopping, non-empty draft):
 * - enter_sends: Enter AND Ctrl/Cmd/Alt+Enter are swallowed (preventDefault) - NO newline is
 *   inserted and the draft value never changes (onDraftChange is never called by a keydown).
 * - mod_enter_sends: Ctrl/Cmd+Enter (and Alt+Enter) are swallowed without firing steer; plain
 *   Enter is NOT prevented - the browser inserts the newline itself (unchanged mod-mode binding).
 * - Shift+Enter and IME-composing Enter are never prevented in either mode.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initialAgentChatState, type AgentChatState } from '../../lib/agui/client/chat-state';
import type { ChatSendKeyMode } from '@/lib/chat-send-key';

type View = typeof import('./agent-chat');
let AgentChatView: View['AgentChatView'];

type El = React.ReactElement<Record<string, any>>;

/** Records every call to ANY prop callback the keydown handler could reach. */
interface CallLog {
  sends: number;
  steers: number;
  draftChanges: string[];
  other: string[];
}

function makeLog(): CallLog {
  return { sends: 0, steers: 0, draftChanges: [], other: [] };
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
    onDraftChange: (value: string) => {
      log.draftChanges.push(value);
    },
    onSend: () => {
      log.sends += 1;
    },
    onSteer: () => {
      log.steers += 1;
    },
    onStop: () => {
      log.other.push('onStop');
    },
    onToolDecision: () => {
      log.other.push('onToolDecision');
    },
    onDismissError: () => {
      log.other.push('onDismissError');
    },
    onLoadPrevious: () => {
      log.other.push('onLoadPrevious');
    },
    onJumpToLatest: () => {
      log.other.push('onJumpToLatest');
    },
    ...extra,
  };
}

function walkEl(node: React.ReactNode, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => walkEl(n, out));
  else if (React.isValidElement(node)) {
    out.push(node as El);
    walkEl((node as El).props.children, out);
  }
  return out;
}

/** Drive a keydown; returns whether the handler preventDefault-ed it. */
function press(el: El, event: Record<string, unknown>): boolean {
  let prevented = false;
  el.props.onKeyDown({ preventDefault: () => (prevented = true), nativeEvent: {}, ...event });
  return prevented;
}

const STOPPING_STATUS = 'stopping' as const;

function composerTextarea(view: React.ReactNode): El {
  const el = walkEl(view).find((e) => e.type === 'textarea' && e.props['aria-label'] === 'Message');
  assert.ok(el, 'the composer textarea is rendered');
  return el!;
}

/** Elements INSIDE the composer form whose own text children mention "stopping". */
function stoppingTextElements(view: React.ReactNode): El[] {
  const form = walkEl(view).find((e) => e.type === 'form');
  assert.ok(form, 'the composer form is rendered');
  return walkEl(form).filter((e) => {
    const kids = Array.isArray(e.props.children) ? e.props.children : [e.props.children];
    const text = kids.filter((c) => typeof c === 'string').join('');
    return /stopping/i.test(text);
  });
}

function assertSilentLog(log: CallLog, what: string): void {
  assert.deepEqual(log, { sends: 0, steers: 0, draftChanges: [], other: [] }, what);
}

describe('S301-S3 assistant composer: Enter stays silent while stopping (PM decision, #301)', () => {
  before(async () => {
    // tsx compiles JSX with the classic runtime; agent-chat.tsx resolves React.createElement
    // from the global (same as agent-chat-send-key.test.ts).
    (globalThis as { React?: unknown }).React = React;
    ({ AgentChatView } = await import('./agent-chat'));
  });

  it('enter_sends: every send chord is swallowed with no send, no steer, no draft change', () => {
    const log = makeLog();
    const el = composerTextarea(
      AgentChatView(makeProps(log, { status: STOPPING_STATUS }, { draft: 'do not send me', sendKeyMode: 'enter_sends' })),
    );
    assert.equal(el.props.value, 'do not send me', 'the textarea keeps the draft while stopping');

    assert.equal(press(el, { key: 'Enter' }), true, 'Enter is swallowed (no newline) while stopping');
    for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      assert.equal(press(el, { key: 'Enter', [mod]: true }), true, `${mod}+Enter is swallowed while a run is open`);
    }
    assert.equal(press(el, { key: 'Enter', shiftKey: true }), false, 'Shift+Enter stays a newline');
    assert.equal(press(el, { key: 'Enter', isComposing: true }), false, 'IME Enter is never swallowed');
    assertSilentLog(log, 'no second send / steer / draft edit while stopping (enter_sends)');
    assert.equal(el.props.value, 'do not send me', 'the draft value is untouched by the swallowed presses');
  });

  it('mod_enter_sends: Ctrl/Cmd+Enter is swallowed without steer; plain Enter stays the browser newline', () => {
    const log = makeLog();
    const el = composerTextarea(
      AgentChatView(
        makeProps(log, { status: STOPPING_STATUS }, { draft: 'do not steer me', sendKeyMode: 'mod_enter_sends' }),
      ),
    );
    assert.equal(el.props.value, 'do not steer me');

    // CURRENT behaviour pinned: plain Enter is NOT prevented in mod mode - the textarea (the
    // browser) inserts the newline; the React value simply stays whatever onDraftChange last set.
    assert.equal(press(el, { key: 'Enter' }), false, 'mod mode: plain Enter reaches the textarea as a newline');
    assert.equal(press(el, { key: 'Enter', ctrlKey: true }), true, 'the steer chord is swallowed while stopping');
    assert.equal(press(el, { key: 'Enter', metaKey: true }), true);
    assert.equal(press(el, { key: 'Enter', altKey: true }), true);
    assert.equal(press(el, { key: 'Enter', shiftKey: true }), false, 'Shift+Enter stays a newline');
    assert.equal(press(el, { key: 'Enter', isComposing: true }), false, 'IME Enter is never swallowed');
    assertSilentLog(log, 'no steer / send / draft edit while stopping (mod_enter_sends)');
    assert.equal(el.props.value, 'do not steer me');
  });

  for (const mode of ['enter_sends', 'mod_enter_sends'] as const) {
    it(`${mode}: the swallowed press renders zero feedback - no toast, no stopping hint, markup unchanged`, () => {
      const log = makeLog();
      const props = makeProps(log, { status: STOPPING_STATUS }, { draft: 'press me', sendKeyMode: mode });
      const view = AgentChatView(props);
      const before = renderToStaticMarkup(React.createElement(AgentChatView, props));
      const el = composerTextarea(view);

      // The ONLY stopping-mentioning text inside the composer is the pre-existing run-status
      // label (span[data-run-status] -> STATUS_LABEL.stopping). A press-time or persistent
      // "stopping…" hint added to the composer is the regression this pins out.
      const stoppingEls = stoppingTextElements(view);
      assert.equal(stoppingEls.length, 1, 'exactly one stopping text in the composer: the run-status label');
      assert.ok('data-run-status' in stoppingEls[0]!.props, 'it is the data-run-status span - no stopping hint');

      // The send-key hint must stay the shipped running-mode copy (never re-worded about stopping).
      const hint = walkEl(view).find((e) => 'data-send-key-hint' in e.props);
      assert.ok(hint, 'the send-key hint is rendered');
      const expectedHint =
        mode === 'enter_sends'
          ? 'Enter queues, Ctrl+Enter steers'
          : 'Ctrl/Cmd+Enter steers, Enter for a new line';
      const hintKids = Array.isArray(hint!.props.children) ? hint!.props.children : [hint!.props.children];
      assert.equal(hintKids.filter((c) => typeof c === 'string').join(''), expectedHint);

      // Press every send chord of this mode, then re-render: zero UI delta (silent by decision).
      press(el, { key: 'Enter' });
      for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) press(el, { key: 'Enter', [mod]: true });
      assertSilentLog(log, 'the press fired no callback at all');
      assert.equal(
        renderToStaticMarkup(React.createElement(AgentChatView, props)),
        before,
        'a swallowed press changes nothing in the rendered composer (no toast / hint appears)',
      );
    });
  }

  it('idle control: no stopping text in the composer when the run is idle', () => {
    const log = makeLog();
    const view = AgentChatView(makeProps(log, { status: 'idle' }, { draft: 'x' }));
    assert.deepEqual(stoppingTextElements(view), [], 'the stopping label is status-driven, not always-on');
  });

  it('source pin: the composer module has no toast wiring to give the swallowed press feedback', () => {
    // The PM decision says the swallowed press shows no toast. The assistant composer module
    // imports no toast library today; adding press feedback through a toast would have to add
    // this import back, which fails this pin (and the render pins above).
    const src = readFileSync(fileURLToPath(new URL('./agent-chat.tsx', import.meta.url)), 'utf8');
    assert.doesNotMatch(src, /from ['"]sonner['"]|import\(['"]sonner['"]\)/, 'no toast library import in the composer module');
    assert.doesNotMatch(src, /\btoast\s*\(/, 'no toast() call in the composer module');
  });
});
