import type { ChatThreadInfo } from './use-agent-chat-session';

/**
 * Select the appropriate thread to auto-bind after bootstrap or delete.
 * 
 * Product rules:
 * - Only auto-select OWN threads (isOwn === true)
 * - Do NOT auto-bind shared/untagged threads (isShared === true)
 * - If no own threads, return null (caller creates new chat)
 * 
 * @param threads - All threads from loadThreads (own first, then shared)
 * @param preferredThreadId - Optional thread ID to prefer if it's in the own list
 * @returns Thread ID to bind, or null to create new chat
 */
export function selectThreadToBind(
  threads: ChatThreadInfo[],
  preferredThreadId?: string | null,
): string | null {
  // Filter to only own threads (never auto-bind shared)
  const ownThreads = threads.filter((t) => t.isOwn);

  // If preferred thread is in own list, use it
  if (preferredThreadId && ownThreads.some((t) => t.id === preferredThreadId)) {
    return preferredThreadId;
  }

  // Otherwise, use first own thread (newest)
  // If no own threads, return null (caller creates new chat)
  return ownThreads[0]?.id ?? null;
}
