/**
 * TASK-LIST-WID S8 (#193): the server-side parked-card messages must name the task list card the
 * way the client does (agent-chat.tsx CARD_KIND). Without the `showTaskList` entry in
 * parked-widgets.ts CARD_KIND, refusals say "widget card" - mutant M17.
 *
 * #201 soft S3: both sides now import the one map from lib/assistant/card-kind.ts (M17 drift class);
 * this file pins the server side, agent-chat-cards.test.ts pins the client side.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parkedWidgetMessage, widgetCardKind } from './parked-widgets';
import { CARD_KIND, cardKindLabel } from '../assistant/card-kind';

describe('WID-3 parked-card naming (S8)', () => {
  it('names every known card kind, including the TASK-LIST-WID task list card (pins mutant M17)', () => {
    assert.equal(widgetCardKind('askQuestion'), 'question card');
    assert.equal(widgetCardKind('askChoice'), 'choice card');
    assert.equal(widgetCardKind('askForm'), 'form card');
    assert.equal(widgetCardKind('askConfirm'), 'confirmation card');
    assert.equal(widgetCardKind('showTaskList'), 'task list card');
    assert.equal(widgetCardKind('someUnknownTool'), 'widget card'); // unknown tools still fall back
  });

  it('the parked send-refusal message names a task list card, with its label when it has one', () => {
    const parked = { threadId: 't-1', toolCallId: 'c-1', toolName: 'showTaskList', label: 'What I am working on' };
    assert.equal(
      parkedWidgetMessage(parked, true),
      'A task list card (“What I am working on”) in this chat is waiting for your answer. Answer or dismiss it, or stop the run, then send again.',
    );
    assert.match(
      parkedWidgetMessage({ threadId: 't-1', toolCallId: 'c-1', toolName: 'showTaskList' }, false),
      /^A task list card in another chat with this agent is waiting for your answer\./,
    );
  });

  // #201 soft S3: the M17 drift class is closed at the root — neither side keeps a hand-copied map;
  // both name cards through the one shared CARD_KIND.
  it('both sides name cards through the shared CARD_KIND module (S3, no hand-copied map)', () => {
    const serverSrc = readFileSync(join(__dirname, 'parked-widgets.ts'), 'utf8');
    const clientSrc = readFileSync(join(__dirname, '..', '..', 'components', 'assistant', 'agent-chat.tsx'), 'utf8');
    assert.match(serverSrc, /import \{ cardKindName \} from '@\/lib\/assistant\/card-kind'/);
    assert.match(clientSrc, /import \{ cardKindName \} from '@\/lib\/assistant\/card-kind'/);
    assert.doesNotMatch(serverSrc, /const CARD_KIND/);
    assert.doesNotMatch(clientSrc, /const CARD_KIND/);
  });

  // #215 soft S21b: the shared lookup must not resolve prototype keys. Before the hardening the
  // map was a plain Record and `CARD_KIND['toString']` hit Object.prototype.toString — not
  // nullish, so `?? 'widget'` never fired and the refusal said
  // "function toString() { [native code] } card".
  it('prototype keys fall back to "widget", never resolving through Object.prototype (S21b)', () => {
    assert.equal(widgetCardKind('toString'), 'widget card');
    assert.equal(widgetCardKind('constructor'), 'widget card');
    assert.equal(widgetCardKind('__proto__'), 'widget card');
    assert.equal(cardKindLabel('hasOwnProperty'), 'widget');
  });
});

// #215 soft S21b: compile-time pin (teeth are in `tsc --noEmit`, see S22b note below) — the
// shared map is readonly. Drop `as const` from card-kind.ts (and `Object.freeze` with it) and
// tsc reports this directive as unused, failing the gate's tip-vs-main error-set check.
//
// #217 soft S22a: the assignment used to sit at top level, so it EXECUTED on file load —
// `as const` is compile-time only and the shared object was really written to (harmless only
// because the value was the same). The arrow is never invoked, so tsc still type-checks the
// write and the directive still pins, but nothing mutates at runtime. The value is deliberately
// wrong ('x'): if the wrapper is ever unwrapped back to top level on an unfrozen map, the
// naming asserts above (widgetCardKind('askChoice') === 'choice card') go RED instead of
// silently drifting; with the freeze in place such a write is neutralised as well.
void (() => {
  // @ts-expect-error CARD_KIND is readonly as of #215 S21b
  CARD_KIND.askChoice = 'x';
});

// #217 soft S22b: two guards, two failure modes.
// 1. The runtime guard below is always on: card-kind.ts freezes CARD_KIND (#217 S22a
//    hardening), so a mistaken runtime write is a no-op (sloppy) / TypeError (strict) and this
//    assert goes RED if the freeze is dropped. This is the guard that bites TODAY, under the
//    pre-existing apps/web tsc noise.
// 2. The compile pin above bites via the gate's tip-vs-main `tsc --noEmit` error-set
//    comparison — apps/web still carries pre-existing `error TS` records, so it only fails CI
//    once apps/web tsc is clean. Until then, the runtime guard is the load-bearing one.
// Note: `Object.freeze`'s `Readonly<T>` return alone also keeps the directive used; the full
// drop-to-make-it-unused mutant is `as const` AND freeze removed together in card-kind.ts.
describe('CARD_KIND runtime hardening (S22a–b)', () => {
  it('the shared CARD_KIND map is frozen at runtime, not just readonly to tsc', () => {
    assert.ok(Object.isFrozen(CARD_KIND), 'card-kind.ts must Object.freeze(CARD_KIND)');
  });
});
