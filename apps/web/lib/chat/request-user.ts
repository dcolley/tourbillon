/**
 * TASK-1: best-effort board-user identity for a chat HTTP request.
 *
 * The private chat task list stamps `requested_by_user_id` / `requested_by_display_name` from the
 * human who made the request, when one is resolvable. Auth is still interim (issue #105): a board
 * session cookie carrying a Better-Auth session means a real board user; anything else (agent
 * bearer token, cookie-less same-origin call) resolves to null and the task is stored with the
 * requester unknown. Never throws — an auth lookup outage must not take chat down.
 */
import { auth } from '@/lib/auth';

export interface ChatRequestUser {
  userId: string;
  displayName?: string;
}

/** Resolve the chat-session board user from request headers, or null when unknown. */
export async function resolveChatRequestUser(headers: Headers): Promise<ChatRequestUser | null> {
  try {
    const session = await auth.api.getSession({ headers });
    if (!session?.user?.id) return null;
    return {
      userId: session.user.id,
      displayName: session.user.name ?? session.user.email ?? session.user.id,
    };
  } catch {
    return null;
  }
}
