/**
 * Applies AgentController session stream events to the open chat's message list.
 *
 * Since Mastra 1.75 (#96) `message_update` carries only `{ id, event }` (a text delta or a
 * replaced part) and `message_end` carries only `{ id }`. The full message is no longer on
 * every event, so the client must apply deltas itself and also take the authoritative
 * `displayState.currentMessage` snapshot. Older shapes that do carry `message` still merge.
 */
import type { ChatMessage, ChatMessagePart } from './use-agent-chat-session';

export interface ChatStreamEvent {
  type?: string;
  [key: string]: unknown;
}

type MessageEvent =
  | { type: 'text-delta'; delta?: unknown }
  | { type: 'part'; index?: unknown; part?: unknown }
  | { type?: string; [key: string]: unknown };

function cloneParts(message: ChatMessage): ChatMessagePart[] {
  return Array.isArray(message.content?.parts) ? [...message.content.parts] : [];
}

function withParts(message: ChatMessage, parts: ChatMessagePart[]): ChatMessage {
  return { ...message, content: { ...message.content, parts } };
}

/** Upper bound for a part index from the stream; larger indexes are ignored. */
export const MAX_PART_INDEX = 10_000;

/** True when a message names a thread other than the open one (it must not render here). */
export function isForeignThreadMessage(message: ChatMessage, openThreadId: string | null | undefined): boolean {
  const tid = (message as { threadId?: unknown }).threadId;
  return typeof tid === 'string' && tid !== '' && typeof openThreadId === 'string' && openThreadId !== '' && tid !== openThreadId;
}

/** Apply one `message_update` sub-event to an existing message. Unknown sub-events are no-ops. */
export function applyMessageUpdate(message: ChatMessage, update: MessageEvent): ChatMessage {
  if (update.type === 'text-delta' && typeof update.delta === 'string') {
    const parts = cloneParts(message);
    const last = parts[parts.length - 1];
    if (last && last.type === 'text') {
      parts[parts.length - 1] = { ...last, text: `${typeof last.text === 'string' ? last.text : ''}${update.delta}` };
    } else {
      parts.push({ type: 'text', text: update.delta });
    }
    return withParts(message, parts);
  }
  if (
    update.type === 'part' &&
    typeof update.index === 'number' &&
    Number.isInteger(update.index) &&
    update.index >= 0 &&
    update.index <= MAX_PART_INDEX &&
    update.part &&
    typeof update.part === 'object'
  ) {
    const parts = cloneParts(message);
    // Replace an existing part or append one; never open a sparse gap.
    if (update.index > parts.length) return message;
    parts[update.index] = update.part as ChatMessagePart;
    return withParts(message, parts.filter(Boolean));
  }
  return message;
}

/**
 * Message to merge for a stream event, or null when the event does not change the list.
 * `current` looks up the message already shown with that id (needed to apply deltas).
 */
export function chatStreamMessageFor(
  event: ChatStreamEvent,
  current: (id: string) => ChatMessage | undefined,
  openThreadId?: string | null,
): ChatMessage | null {
  const full = event.message as ChatMessage | undefined;
  if (
    (event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end') &&
    full?.id
  ) {
    return isForeignThreadMessage(full, openThreadId) ? null : full;
  }
  if (event.type === 'message_update' && typeof event.id === 'string') {
    const existing = current(event.id);
    if (!existing) return null;
    const next = applyMessageUpdate(existing, (event.event ?? {}) as MessageEvent);
    return next === existing ? null : next;
  }
  if (event.type === 'display_state_changed') {
    // Only while running: after agent_end the snapshot is stale and the thread reload wins.
    const ds = event.displayState as
      | { isRunning?: boolean; currentMessage?: ChatMessage | null }
      | undefined;
    const snapshot = ds?.currentMessage;
    if (ds?.isRunning === true && snapshot?.id && snapshot.role === 'assistant') {
      return isForeignThreadMessage(snapshot, openThreadId) ? null : snapshot;
    }
  }
  return null;
}

/** Running flag after an event, or undefined when the event does not say. */
export function chatStreamRunningFor(event: ChatStreamEvent): boolean | undefined {
  if (event.type === 'display_state_changed') {
    const ds = event.displayState as { isRunning?: boolean } | undefined;
    return ds?.isRunning === true;
  }
  if (event.type === 'agent_start') return true;
  if (event.type === 'agent_end') return false;
  return undefined;
}

/** Side effects of one stream event for the hook: running flag and which thread to reload. */
export function chatStreamEffectsFor(
  event: ChatStreamEvent,
  openThreadId: string | null | undefined,
): { running: boolean | undefined; reloadThreadId: string | null } {
  return {
    running: chatStreamRunningFor(event),
    reloadThreadId: event.type === 'agent_end' && openThreadId ? openThreadId : null,
  };
}
