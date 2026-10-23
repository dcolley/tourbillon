import {
  chatResourceId,
  getChatSession,
  getOrCreateChatController,
  type TourbillonChatSession,
} from '@/lib/chat';
import { NextResponse } from 'next/server';
import { chatErrorResponse } from '@/lib/chat/route-helpers';
import {
  ASSISTANT_THREAD_PINNED_KEY,
  ASSISTANT_THREAD_READ_MESSAGE_KEY,
  filterThreadsByTitle,
  isThreadUnread,
  sortAssistantThreads,
  type AssistantThread,
} from './sidebar';

/**
 * UI-2: thread data for the assistant sidebar.
 * Threads live in Mastra memory under the company's free-chat resource (the same resource the
 * chat pane uses), so the sidebar shows the same conversations. The assistant view manages them
 * through its own session scope, so it never re-binds a chat-pane session.
 */
export const ASSISTANT_SESSION_SCOPE = 'assistant';
/** Upper bound on threads examined per listing (newest by update time). */
export const ASSISTANT_THREAD_SCAN_LIMIT = 200;
export const ASSISTANT_THREAD_DEFAULT_LIMIT = 50;

export class AssistantThreadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AssistantThreadError';
  }
}

export function assistantErrorResponse(err: unknown): NextResponse {
  if (err instanceof AssistantThreadError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return chatErrorResponse(err);
}

type AgentLike = { id: string; companyId: string };
type StoredThread = Awaited<ReturnType<TourbillonChatSession['thread']['list']>>[number];

export function assistantResourceId(companyId: string): string {
  return chatResourceId(companyId);
}

export async function openAssistantSession<A extends AgentLike>(agent: A): Promise<TourbillonChatSession> {
  const controller = await getOrCreateChatController(agent as never);
  return getChatSession(controller, agent as never, {
    resourceId: assistantResourceId(agent.companyId),
    scope: ASSISTANT_SESSION_SCOPE,
    // Listing/renaming must not leave an empty "new thread" behind in the shared resource.
    createInitialThread: false,
  });
}

const metadataOf = (t: { metadata?: unknown }) => (t.metadata as Record<string, unknown> | undefined) ?? {};
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : typeof d === 'string' ? d : null);
const time = (d: unknown) => (d instanceof Date ? d.getTime() : typeof d === 'string' ? Date.parse(d) || 0 : 0);

/** Same visibility as the chat thread list: the agent's own threads plus untagged shared threads. */
export function isThreadVisibleToAgent(thread: { metadata?: unknown }, agentId: string): boolean {
  const owner = metadataOf(thread).agentId;
  return owner === undefined || owner === null || owner === '' || owner === agentId;
}

export async function toAssistantThread(
  session: TourbillonChatSession,
  thread: StoredThread,
): Promise<AssistantThread> {
  const metadata = metadataOf(thread);
  const [last] = await session.thread.listMessages({ threadId: thread.id, limit: 1 });
  const lastAt = last ? iso((last as { createdAt?: unknown }).createdAt) : null;
  return {
    id: thread.id,
    agentId: typeof metadata.agentId === 'string' && metadata.agentId ? metadata.agentId : null,
    title: thread.title ?? '',
    pinned: metadata[ASSISTANT_THREAD_PINNED_KEY] === true,
    unread: isThreadUnread({
      lastMessageId: last?.id,
      lastMessageRole: (last as { role?: string } | undefined)?.role,
      readMessageId: metadata[ASSISTANT_THREAD_READ_MESSAGE_KEY],
    }),
    lastActivityAt: lastAt ?? iso(thread.createdAt),
    createdAt: iso(thread.createdAt),
  };
}

export async function listAssistantThreads(
  session: TourbillonChatSession,
  agent: AgentLike,
  opts: { query?: string | null; limit?: number } = {},
): Promise<AssistantThread[]> {
  const resourceId = assistantResourceId(agent.companyId);
  const stored = (await session.thread.list())
    .filter((t) => t.resourceId === resourceId && isThreadVisibleToAgent(t, agent.id))
    .sort((a, b) => time(b.updatedAt ?? b.createdAt) - time(a.updatedAt ?? a.createdAt))
    .slice(0, ASSISTANT_THREAD_SCAN_LIMIT);
  const matching = filterThreadsByTitle(stored.map((t) => ({ t, title: t.title ?? '' })), opts.query).map((x) => x.t);
  const mapped = await Promise.all(matching.map((t) => toAssistantThread(session, t)));
  const limit = opts.limit && opts.limit > 0 ? opts.limit : ASSISTANT_THREAD_DEFAULT_LIMIT;
  return sortAssistantThreads(mapped).slice(0, limit);
}

/** The thread, if it is in this company's assistant resource and visible to the agent; else 404. */
export async function requireAssistantThread(
  session: TourbillonChatSession,
  agent: AgentLike,
  threadId: string,
): Promise<StoredThread> {
  const thread = await session.thread.getById({ threadId });
  if (!thread || thread.resourceId !== assistantResourceId(agent.companyId) || !isThreadVisibleToAgent(thread, agent.id)) {
    throw new AssistantThreadError('Thread not found', 404);
  }
  return thread;
}

export async function updateAssistantThread(
  session: TourbillonChatSession,
  agent: AgentLike,
  threadId: string,
  changes: { title?: string; pinned?: boolean; read?: boolean },
): Promise<AssistantThread> {
  await requireAssistantThread(session, agent, threadId);

  if (changes.title !== undefined) {
    if (session.thread.getId() !== threadId) await session.thread.switch({ threadId, emitEvent: false });
    await session.thread.rename({ title: changes.title });
  }
  if (changes.pinned !== undefined) {
    await session.thread.setSettingOn({ threadId, key: ASSISTANT_THREAD_PINNED_KEY, value: changes.pinned });
  }
  if (changes.read) {
    const [last] = await session.thread.listMessages({ threadId, limit: 1 });
    if (last) await session.thread.setSettingOn({ threadId, key: ASSISTANT_THREAD_READ_MESSAGE_KEY, value: last.id });
  }

  return toAssistantThread(session, await requireAssistantThread(session, agent, threadId));
}

export async function createAssistantThread(
  session: TourbillonChatSession,
  agent: AgentLike,
  opts: { title?: string } = {},
): Promise<AssistantThread> {
  const thread = await session.thread.create({ title: opts.title });
  await session.thread.setSettingOn({ threadId: thread.id, key: 'kind', value: 'chat' });
  await session.thread.setSettingOn({ threadId: thread.id, key: 'agentId', value: agent.id });
  return toAssistantThread(session, await requireAssistantThread(session, agent, thread.id));
}
