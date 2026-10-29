/**
 * #201 soft S3: the one CARD_KIND map behind the parked-card wording.
 *
 * The client (components/assistant/agent-chat.tsx, `parkedCardKind`) and the server
 * (lib/agui/parked-widgets.ts, `widgetCardKind`) both name a card the same way ("choice card",
 * "task list card"). Each kept a hand-copied map until the M17 drift class (the task list entry
 * landed on one side only, so refusals said "widget card" on the other). Both sides now import
 * this module — one map, checked by the tests on each side (agent-chat-cards.test.ts,
 * parked-widgets.test.ts).
 *
 * Plain text only: the value is the bare kind ("task list"); `cardKindName` adds " card".
 * Unknown tool names fall back to "widget" so an unregistered card is still named sensibly.
 */
export const CARD_KIND: Record<string, string> = {
  askQuestion: 'question',
  askChoice: 'choice',
  askForm: 'form',
  askConfirm: 'confirmation',
  showTaskList: 'task list',
};

/** The bare kind of a card tool ("task list"), or "widget" for an unknown tool name. */
export function cardKindLabel(toolName: string): string {
  return CARD_KIND[toolName] ?? 'widget';
}

/** Plain name of a card kind ("task list card"), for messages. */
export function cardKindName(toolName: string): string {
  return `${cardKindLabel(toolName)} card`;
}
