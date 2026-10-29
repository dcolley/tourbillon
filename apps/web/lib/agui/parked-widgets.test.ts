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
});
