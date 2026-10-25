/**
 * WID-3: widget cards a session's run is parked on, as the chat needs them after a reload.
 *
 * A widget call suspends the run and the AG-UI stream ends on an interrupt, but the session's run
 * stays parked until the card is answered, dismissed or the run is stopped. The chat does not keep
 * its items across a reload, so:
 * - `pendingWidgetCards` lists the cards this session asked on a thread that are still waiting, with
 *   the props they were asked with (recorded with the owner, lib/agui/widget-owners.ts), so the chat
 *   can show them again and the Board can answer or dismiss them;
 * - `parkedWidgetCall` names the card the session's run is parked on (on whichever thread the session
 *   is bound to), so a send that is refused because of it can say which card and offer Stop.
 * Only the asking session's own cards are reported (never another session's).
 */
import type { WidgetSpecIndex } from '@tourbillon/shared/widgets';
import { suspendedWidgetSpec } from './widgets';
import { pendingOwnedWidgetCalls, widgetCallArgs } from './widget-owners';

export interface PendingWidgetCard {
  toolCallId: string;
  toolName: string;
  /** Props the card was asked with. */
  args: Record<string, unknown>;
}

export interface ParkedWidgetCall {
  /** Thread the parked run belongs to (may differ from the thread of the refused request). */
  threadId: string;
  toolCallId: string;
  toolName: string;
  /** Short text of the card (its question or title), when it has one. */
  label?: string;
}

interface ParkedSession {
  suspensions?: {
    has(args: { toolCallId: string }): boolean;
    get(args: { toolCallId: string }): { toolName: string } | undefined;
  };
  getCurrentRunId(): string | null | undefined;
  thread?: { getId(): string | null | undefined };
}

const LABEL_MAX = 120;

/** The card's question or title, on one line and shortened, or undefined. */
export function widgetCardLabel(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const a = args as Record<string, unknown>;
  const raw = typeof a.question === 'string' ? a.question : typeof a.title === 'string' ? a.title : undefined;
  const text = raw?.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
}

const CARD_KIND: Record<string, string> = {
  askQuestion: 'question',
  askChoice: 'choice',
  askForm: 'form',
  askConfirm: 'confirmation',
};

/** Plain name of a card kind ("question card"), for messages. */
export function widgetCardKind(toolName: string): string {
  return `${CARD_KIND[toolName] ?? 'widget'} card`;
}

/** Cards this session asked on `threadId` that are still waiting for an answer. */
export function pendingWidgetCards(
  index: WidgetSpecIndex,
  session: ParkedSession & object,
  resourceId: string,
  threadId: string,
): PendingWidgetCard[] {
  const out: PendingWidgetCard[] = [];
  for (const toolCallId of pendingOwnedWidgetCalls(session, resourceId, threadId)) {
    const spec = suspendedWidgetSpec(index, session, toolCallId);
    const args = widgetCallArgs(resourceId, threadId, toolCallId);
    if (spec && args) out.push({ toolCallId, toolName: spec.name, args });
  }
  return out;
}

/** The card this session's run is parked on, or undefined when its run is not parked on a card. */
export function parkedWidgetCall(
  index: WidgetSpecIndex,
  session: ParkedSession & object,
  resourceId: string,
): ParkedWidgetCall | undefined {
  if (!session.getCurrentRunId()) return undefined;
  const threadId = session.thread?.getId();
  if (!threadId) return undefined;
  for (const toolCallId of pendingOwnedWidgetCalls(session, resourceId, threadId)) {
    const spec = suspendedWidgetSpec(index, session, toolCallId);
    if (!spec) continue;
    const label = widgetCardLabel(widgetCallArgs(resourceId, threadId, toolCallId));
    return { threadId, toolCallId, toolName: spec.name, ...(label ? { label } : {}) };
  }
  return undefined;
}

/** Message for a send refused because the session's run is parked on a card. */
export function parkedWidgetMessage(parked: ParkedWidgetCall, sameThread: boolean): string {
  const what = `A ${widgetCardKind(parked.toolName)}${parked.label ? ` (“${parked.label}”)` : ''}`;
  const where = sameThread ? 'in this chat' : 'in another chat with this agent';
  return `${what} ${where} is waiting for your answer. Answer or dismiss it, or stop the run, then send again.`;
}
