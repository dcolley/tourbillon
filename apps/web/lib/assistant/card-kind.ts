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
 *
 * #215 soft S21b: the map is `as const satisfies` (a write to it is a tsc error, pinned by a
 * `@ts-expect-error` directive in parked-widgets.test.ts) and the lookup goes through
 * `Object.hasOwn` — a plain `CARD_KIND[name] ?? 'widget'` resolved inherited names
 * (`toString`, `constructor`) to `Object.prototype` members, and a refusal said
 * "function toString() { [native code] } card" (behaviour predates #215).
 *
 * #217 soft S22a: `Object.freeze` backs the compile-time readonly with a runtime guarantee —
 * a mistaken write is a no-op (sloppy) / TypeError (strict). Pinned by
 * `Object.isFrozen(CARD_KIND)` in parked-widgets.test.ts (S22b).
 */
export const CARD_KIND = Object.freeze({
  askQuestion: 'question',
  askChoice: 'choice',
  askForm: 'form',
  askConfirm: 'confirmation',
  showTaskList: 'task list',
} as const satisfies Record<string, string>);

/** The bare kind of a card tool ("task list"), or "widget" for an unknown tool name. */
export function cardKindLabel(toolName: string): string {
  return Object.hasOwn(CARD_KIND, toolName) ? CARD_KIND[toolName as keyof typeof CARD_KIND] : 'widget';
}

/** Plain name of a card kind ("task list card"), for messages. */
export function cardKindName(toolName: string): string {
  return `${cardKindLabel(toolName)} card`;
}
