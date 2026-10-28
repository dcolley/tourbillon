/**
 * TASK-LIST-WID S8 (#193): the server-side parked-card messages must name the task list card the
 * way the client does (agent-chat.tsx CARD_KIND). Without the `showTaskList` entry in
 * parked-widgets.ts CARD_KIND, refusals say "widget card" - mutant M17.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
});
