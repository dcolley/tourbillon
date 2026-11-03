/**
 * S301-S3 (Refs #301): KEEP Enter silent while stopping — PM decision, pinned.
 *
 * While a chat run is in the `stopping` state, a send-key press in the assistant composer is
 * swallowed with NO feedback: no second send, no steer, no toast, and no composer "stopping"
 * hint. That silence is the decided behaviour (Test suggested a "stopping…" hint, PM kept it
 * silent), so a future change must not add a send/steer on the swallowed press or any press
 * feedback. The handler-side comment lives at the composer keydown in agent-chat.tsx.
 *
 * S311-S1..S4 (Refs #301, Test-gate follow-up on the #311 merge) close the survivors of the
 * original no-hint pin:
 * - S1: the old scan only looked at string children INSIDE <form> for the word "stopping", so
 *   a hint above the form (g6), a hint worded without "stopping" (g7), or a hint smuggled into
 *   the textarea `placeholder` (g8) all survived. Fixed by (a) scanning the WHOLE view for
 *   stopping-mentioning text, (b) pinning the stopping placeholder to the plain follow-up copy,
 *   and (c) diffing the full stopping-state markup against the running-state markup with only
 *   the sanctioned run-status deltas normalised.
 * - S2: the stopping label itself is pinned to the canonical STATUS_LABEL string 'Stopping…',
 *   so it cannot be reworded into a press hint (g9).
 * - S3: "markup unchanged after press" now compares against a NEVER-PRESSED baseline captured
 *   in before(), before any test in this file has fired a keydown — a module-level sticky
 *   flash set by an earlier test can no longer hide inside a contaminated same-test baseline
 *   (g15).
 * - S4: form-level submit (onSubmit) while stopping must not reach send/steer either (g14);
 *   pinned directly, with a running-state control so the pin is not vacuous.
 *
 * Idiom: same as agent-chat-send-key.test.ts — no DOM library; the stateless AgentChatView is
 * rendered to markup with react-dom/server and the textarea's onKeyDown is driven directly.
 * The view is stateless and takes `sendKeyMode` as a prop, so neither the container's test seam
 * (S302-S1) nor require-cache stubbing is needed here (S301-S1 rule: never Module._cache — the
 * S3 pristine baseline is captured in before(), not by cache-busting the module).
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

/** Build a stopping/running view and drive its form's onSubmit; returns the props' callback log. */
function submitComposer(mode: ChatSendKeyMode, status: typeof STOPPING_STATUS | typeof RUNNING_STATUS): CallLog {
  const log = makeLog();
  const props = status === STOPPING_STATUS ? stoppingPropsFor(mode, log) : runningPropsFor(mode, log);
  const view = AgentChatView(props);
  const form = walkEl(view).find((e) => e.type === 'form');
  assert.ok(form, 'the composer form is rendered');
  let prevented = false;
  form!.props.onSubmit({ preventDefault: () => (prevented = true) });
  assert.ok(prevented, 'the composer submit stays preventDefault-ed (the page never navigates)');
  return log;
}

const STOPPING_STATUS = 'stopping' as const;
const RUNNING_STATUS = 'running' as const;
const PRESS_DRAFT = 'press me';

/** The canonical running-mode placeholder copy (agent-chat.tsx; identical for running/stopping). */
const RUN_PLACEHOLDER = 'Send a follow-up or steer the reply';

/** The canonical STATUS_LABEL.stopping string (agent-chat.tsx STATUS_LABEL; S311-S2). */
const STOPPING_LABEL = 'Stopping…';

function stoppingPropsFor(mode: ChatSendKeyMode, log: CallLog = makeLog()) {
  return makeProps(log, { status: STOPPING_STATUS }, { draft: PRESS_DRAFT, sendKeyMode: mode });
}

function runningPropsFor(mode: ChatSendKeyMode, log: CallLog = makeLog()) {
  return makeProps(log, { status: RUNNING_STATUS }, { draft: PRESS_DRAFT, sendKeyMode: mode });
}

function composerTextarea(view: React.ReactNode): El {
  const el = walkEl(view).find((e) => e.type === 'textarea' && e.props['aria-label'] === 'Message');
  assert.ok(el, 'the composer textarea is rendered');
  return el!;
}

function textChildren(el: El): string {
  const kids = Array.isArray(el.props.children) ? el.props.children : [el.props.children];
  return kids.filter((c) => typeof c === 'string').join('');
}

/**
 * Elements in the WHOLE view (S311-S1: not just inside <form>) whose own text children mention
 * "stopping". The only legitimate hit while stopping is the run-status label.
 */
function stoppingTextElements(view: React.ReactNode): El[] {
  return walkEl(view).filter((e) => /stopping/i.test(textChildren(e)));
}

/**
 * S311-S1 canonical form for the stopping-vs-running markup diff. The sanctioned deltas between
 * the two states are exactly: the root data-status value, the run-status span text (Stopping… vs
 * Responding…), and the disabled/data-disabled attributes Steer / Stop / Follow up gain while
 * stopping. Everything else - element structure, text anywhere (above the form, inside it), and
 * attributes like the textarea placeholder - must be byte-identical, so a stopping-only hint
 * cannot survive by sitting outside the old in-form / keyword / text-child blind spots.
 *
 * S317-S1: the disabled normalisation is SCOPED to the three sanctioned buttons (matched by
 * their exact label text). Stripping disabled/data-disabled GLOBALLY hid any other
 * stopping-only disabled in the view - e.g. a disabling stopping-only textarea survived the
 * diff and every other assistant/* test. The per-state button/textarea element pins below make
 * the sanctioned gains/absences explicit so the scoped strip cannot go stale in either state.
 */
const SANCTIONED_DISABLED_BUTTONS = ['Steer', 'Stop', 'Follow up'];

function normalizeComposerMarkup(markup: string): string {
  return markup
    .replace(/data-status="(idle|starting|running|stopping)"/g, 'data-status="*"')
    .replace(/data-run-status(?:="[^"]*")?[^>]*>[^<]*<\/span>/g, 'data-run-status="true">§status§</span>')
    .replace(/<button\b[^>]*>[^<]*<\/button>/g, (tag) => {
      const label = />([^<]*)<\/button>/.exec(tag)?.[1]?.trim() ?? '';
      return SANCTIONED_DISABLED_BUTTONS.includes(label)
        ? tag.replace(/ data-disabled=""/g, '').replace(/ disabled=""/g, '')
        : tag;
    });
}

function renderView(props: ReturnType<typeof stoppingPropsFor>): string {
  return renderToStaticMarkup(React.createElement(AgentChatView, props));
}

function assertSilentLog(log: CallLog, what: string): void {
  assert.deepEqual(log, { sends: 0, steers: 0, draftChanges: [], other: [] }, what);
}

describe('S301-S3 assistant composer: Enter stays silent while stopping (PM decision, #301)', () => {
  /**
   * S311-S3: never-pressed baselines, captured before ANY test in this file has fired a
   * keydown/submit. A module-level sticky flash set by a swallowed press (g15) cannot leak into
   * these renders, so "the press changed nothing" is checked against a truly press-free snapshot
   * instead of only against a same-test baseline that earlier tests may already have dirtied.
   */
  let pristineStoppingMarkup: Record<ChatSendKeyMode, string>;

  before(async () => {
    // tsx compiles JSX with the classic runtime; agent-chat.tsx resolves React.createElement
    // from the global (same as agent-chat-send-key.test.ts).
    (globalThis as { React?: unknown }).React = React;
    ({ AgentChatView } = await import('./agent-chat'));
    pristineStoppingMarkup = {
      enter_sends: renderView(stoppingPropsFor('enter_sends')),
      mod_enter_sends: renderView(stoppingPropsFor('mod_enter_sends')),
    };
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
      const props = stoppingPropsFor(mode, log);
      const view = AgentChatView(props);
      const before = renderView(props);
      const el = composerTextarea(view);

      // The ONLY stopping-mentioning text in the whole view is the pre-existing run-status label
      // (span[data-run-status] -> STATUS_LABEL.stopping). A press-time or persistent "stopping…"
      // hint added to the composer - inside the form, above it, anywhere - is the regression
      // this pins out (S311-S1: the scan covers the full view, not just <form>).
      const stoppingEls = stoppingTextElements(view);
      assert.equal(stoppingEls.length, 1, 'exactly one stopping text in the whole view: the run-status label');
      assert.ok('data-run-status' in stoppingEls[0]!.props, 'it is the data-run-status span - no stopping hint');

      // The send-key hint must stay the shipped running-mode copy (never re-worded about stopping).
      const hint = walkEl(view).find((e) => 'data-send-key-hint' in e.props);
      assert.ok(hint, 'the send-key hint is rendered');
      const expectedHint =
        mode === 'enter_sends'
          ? 'Enter queues, Ctrl+Enter steers'
          : 'Ctrl/Cmd+Enter steers, Enter for a new line';
      assert.equal(textChildren(hint!), expectedHint);

      // Press every send chord of this mode, then re-render: zero UI delta (silent by decision).
      press(el, { key: 'Enter' });
      for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) press(el, { key: 'Enter', [mod]: true });
      assertSilentLog(log, 'the press fired no callback at all');
      const after = renderView(props);
      assert.equal(
        after,
        before,
        'a swallowed press changes nothing in the rendered composer (no toast / hint appears)',
      );
      // S311-S3: order-independent check - the post-press markup must also equal the baseline
      // captured in before(), when this module had seen ZERO presses. Without this, a
      // module-level sticky flash set by an earlier test is baked into BOTH the same-test
      // baseline and the post-press render, and the equality above survives (g15).
      assert.equal(
        after,
        pristineStoppingMarkup[mode],
        'the post-press markup equals the never-pressed baseline (no sticky module-level feedback can hide)',
      );
    });

    it(`${mode}: S311-S1 stopping markup equals running markup outside the run-status span`, () => {
      // A stopping-only element, text, or attribute anywhere in the view (above the form, inside
      // it, or in an attribute) survives a keyword/form-bounded scan; a byte diff against the
      // running render with only the sanctioned status deltas normalised does not let it.
      const runningProps = runningPropsFor(mode);
      const stoppingProps = stoppingPropsFor(mode);
      const runningRaw = renderView(runningProps);
      const stoppingRaw = renderView(stoppingProps);
      assert.equal(
        normalizeComposerMarkup(stoppingRaw),
        normalizeComposerMarkup(runningRaw),
        'the stopping view differs from the running view only in data-status, the run-status label, and disabled buttons',
      );

      // S317-S1: the disabled strip above is scoped to the sanctioned buttons, so the sanctioned
      // gains/absences themselves get element pins (keeping the strip honest in both states):
      // Steer / Stop / Follow up must be disabled while stopping and enabled while running.
      for (const label of SANCTIONED_DISABLED_BUTTONS) {
        const stoppingButton = walkEl(AgentChatView(stoppingProps)).find((e) => textChildren(e) === label);
        const runningButton = walkEl(AgentChatView(runningProps)).find((e) => textChildren(e) === label);
        assert.ok(stoppingButton && runningButton, `the ${label} button renders in both states`);
        assert.ok(stoppingButton!.props.disabled, `${label} is disabled while stopping (the sanctioned delta)`);
        assert.ok(!runningButton!.props.disabled, `${label} stays enabled while running`);
      }
      // The composer textarea must stay editable while stopping: it never carries disabled/
      // data-disabled (S317-S1 - the old global strip hid exactly this mutant).
      const taTag = /<textarea\b[^>]*>/.exec(stoppingRaw)?.[0] ?? '';
      assert.ok(taTag, 'the composer textarea is rendered while stopping');
      assert.doesNotMatch(taTag, /\b(?:data-)?disabled\b/, 'the stopping textarea is not disabled (typing stays possible)');
      const taEl = composerTextarea(AgentChatView(stoppingProps));
      assert.ok(!taEl.props.disabled, 'the stopping textarea has no disabled prop');
    });
  }

  it('S311-S1: the stopping textarea placeholder is the plain follow-up copy, not a stopping hint', () => {
    // g8 survivor: a hint smuggled into the placeholder attribute is not a text child, so the
    // text scan cannot see it. Pin the exact running-mode copy, and keep any stopping/waiting
    // phrasing out of the attribute.
    const el = composerTextarea(AgentChatView(stoppingPropsFor('enter_sends')));
    assert.equal(el.props.placeholder, RUN_PLACEHOLDER, 'the stopping placeholder is the running-mode copy verbatim');
    assert.doesNotMatch(String(el.props.placeholder ?? ''), /stopping|press|wait/i, 'no hint wording in the placeholder');
  });

  it('S311-S2: the stopping run-status label is exactly the canonical STATUS_LABEL string', () => {
    // g9 survivor: the old pin only required the stopping text to sit in span[data-run-status],
    // so re-wording the label into a press hint ('Stopping… press Enter does nothing') survived.
    // The label is status display copy, pinned to the canonical STATUS_LABEL.stopping string.
    const view = AgentChatView(stoppingPropsFor('enter_sends'));
    const statusSpan = walkEl(view).find((e) => 'data-run-status' in e.props);
    assert.ok(statusSpan, 'the run-status span is rendered');
    assert.equal(textChildren(statusSpan!), STOPPING_LABEL, "the stopping label is exactly 'Stopping…'");
  });

  it('S311-S4: submitting the composer form while stopping does not send or steer', () => {
    // g14 gap: the keydown handler stays silent, but form-level onSubmit had no stopping pin -
    // dropping the canSend guard in onSubmit would reach onSend on a synthetic submit.
    const log = submitComposer('enter_sends', STOPPING_STATUS);
    assertSilentLog(log, 'a form submit while stopping fires no send / steer / draft edit');

    // Control (keeps the pin above from being vacuous): the same submit while RUNNING with a
    // non-empty draft must reach exactly one send.
    const controlLog = submitComposer('enter_sends', RUNNING_STATUS);
    assert.equal(controlLog.sends, 1, 'the running-state control submit does fire the send');
    assert.equal(controlLog.steers, 0);
  });

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
    assert.doesNotMatch(src, /from ['\"]sonner['\"]|import\(['\"]sonner['\"]\)/, 'no toast library import in the composer module');
    assert.doesNotMatch(src, /\btoast\s*\(/, 'no toast() call in the composer module');
  });
});
