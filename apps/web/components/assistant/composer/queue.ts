/**
 * CHAT-1: follow-ups queued in the composer while a run is open. Pure helpers (immutable lists).
 * Queued items can be edited or removed until they are sent; the composer sends the first one when
 * the run ends, the next when that run ends, and so on.
 */
import type { ChatAttachmentRef } from '@/lib/chat-attachments';

export const MAX_QUEUED = 20;

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: ChatAttachmentRef[];
}

export type QueueResult = { ok: true; queue: QueuedMessage[] } | { ok: false; reason: 'full' | 'empty' };

export function enqueue(queue: readonly QueuedMessage[], item: QueuedMessage): QueueResult {
  if (!item.text.trim() && item.attachments.length === 0) return { ok: false, reason: 'empty' };
  if (queue.length >= MAX_QUEUED) return { ok: false, reason: 'full' };
  return { ok: true, queue: [...queue, item] };
}

/** Edits a queued item's text. An edit that leaves nothing to send removes the item. */
export function editQueued(queue: readonly QueuedMessage[], id: string, text: string): QueuedMessage[] {
  return queue.flatMap((q) => {
    if (q.id !== id) return [q];
    if (!text.trim() && q.attachments.length === 0) return [];
    return [{ ...q, text }];
  });
}

export function removeQueued(queue: readonly QueuedMessage[], id: string): QueuedMessage[] {
  return queue.filter((q) => q.id !== id);
}

export function takeNext(queue: readonly QueuedMessage[]): { next: QueuedMessage | undefined; rest: QueuedMessage[] } {
  const [next, ...rest] = queue;
  return { next, rest };
}
