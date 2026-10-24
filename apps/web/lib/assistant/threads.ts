import {
  chatResourceId,
  getChatSession,
  getOrCreateChatController,
  type TourbillonChatSession,
} from '@/lib/chat';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { chatErrorResponse } from '@/lib/chat/route-helpers';
import {
  ASSISTANT_MAX_PINS_PER_AGENT,
  listPinnedAssistantThreadIds,
  markAssistantThreadReadRow,
  pinAssistantThread,
  renameAssistantThreadRow,
  unpinAssistantThread,
  type PinScope,
  type ThreadScope,
} from '@/lib/assistant/thread-store';
import {
  ASSISTANT_THREAD_LIST_LIMIT,
  ASSISTANT_THREAD_READ_MESSAGE_KEY,
  checkAssistantThreadTitle,
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
 *
 * Only threads tagged to the agent (`metadata.agentId`) are offered: AG-UI refuses threads that
 * are not tagged to the agent, so the list never includes untagged threads.
 */
export const ASSISTANT_SESSION_SCOPE = 'assistant';
/** Upper bound on threads examined per listing (newest by update time). Pinned threads are loaded separately. */
export const ASSISTANT_THREAD_SCAN_LIMIT = 200;
export const ASSISTANT_THREAD_DEFAULT_LIMIT = ASSISTANT_THREAD_LIST_LIMIT;
/** Tags written on every thread the assistant API creates (plus `agentId`); `contextType: 'free'` keeps it in the chat pane's free-chat list. */
export const ASSISTANT_THREAD_TAGS = { kind: 'chat', contextType: 'free' } as const;

/**
 * Thread title as accepted by the assistant API, using the rule shared with the sidebar
 * (`checkAssistantThreadTitle`): trimmed, 1–200 characters, no control, bidi or zero-width characters.
 */
export const assistantThreadTitleSchema = z.string().transform((raw, ctx) => {
  const checked = checkAssistantThreadTitle(raw);
  if (checked.ok) return checked.title;
  ctx.addIssue({ code: 'custom', message: checked.error });
  return z.NEVER;
});

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
  const res = chatErrorResponse(err);
  // Unexpected failures are logged server-side; storage error text is not returned to the client.
  if (res.status >= 500) return NextResponse.json({ error: 'Internal error' }, { status: res.status });
  return res;
}

type AgentLike = { id: string; companyId: string; status?: string | null };
type StoredThread = Awaited<ReturnType<TourbillonChatSession['thread']['list']>>[number];

export function assistantResourceId(companyId: string): string {
  return chatResourceId(companyId);
}

/** Archived agents keep their history readable; creating, renaming and pinning are refused. */
export function assertAgentWritable(agent: AgentLike): void {
  if (agent.status === 'archived') {
    throw new AssistantThreadError('Agent is archived; its threads are read-only', 409);
  }
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

/** Only the agent's own threads (tagged `agentId`); untagged threads are never offered. */
export function isThreadVisibleToAgent(thread: { metadata?: unknown }, agentId: string): boolean {
  return metadataOf(thread).agentId === agentId;
}

/** In this company's free-chat resource and tagged to the agent. */
export function isAssistantThreadInScope(
  thread: { resourceId?: string | null; metadata?: unknown },
  agent: AgentLike,
): boolean {
  return thread.resourceId === assistantResourceId(agent.companyId) && isThreadVisibleToAgent(thread, agent.id);
}

const pinScope = (agent: AgentLike, viewerKey: string): PinScope => ({
  userKey: viewerKey,
  companyId: agent.companyId,
  agentId: agent.id,
});
const threadScope = (agent: AgentLike, threadId: string): ThreadScope => ({
  threadId,
  resourceId: assistantResourceId(agent.companyId),
  agentId: agent.id,
});

export async function toAssistantThread(
  session: TourbillonChatSession,
  thread: StoredThread,
  pinned: boolean,
): Promise<AssistantThread> {
  const metadata = metadataOf(thread);
  const [last] = await session.thread.listMessages({ threadId: thread.id, limit: 1 });
  const lastAt = last ? iso((last as { createdAt?: unknown }).createdAt) : null;
  return {
    id: thread.id,
    agentId: typeof metadata.agentId === 'string' && metadata.agentId ? metadata.agentId : null,
    title: thread.title ?? '',
    pinned,
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
  opts: { viewerKey: string; query?: string | null; limit?: number; scanLimit?: number },
): Promise<AssistantThread[]> {
  const scanLimit = opts.scanLimit ?? ASSISTANT_THREAD_SCAN_LIMIT;
  const pinnedIds = await listPinnedAssistantThreadIds(pinScope(agent, opts.viewerKey));
  const pinnedSet = new Set(pinnedIds);

  const scanned = (await session.thread.list())
    .filter((t) => isAssistantThreadInScope(t, agent))
    .sort((a, b) => time(b.updatedAt ?? b.createdAt) - time(a.updatedAt ?? a.createdAt))
    .slice(0, scanLimit);
  // Pinned threads are loaded by id, so they never fall out of the newest-N scan.
  const seen = new Set(scanned.map((t) => t.id));
  const pinned = (
    await Promise.all(pinnedIds.filter((id) => !seen.has(id)).map((threadId) => session.thread.getById({ threadId })))
  ).filter((t): t is StoredThread => !!t && isAssistantThreadInScope(t, agent));

  const candidates = [...pinned, ...scanned];
  const matching = filterThreadsByTitle(candidates.map((t) => ({ t, title: t.title ?? '' })), opts.query).map((x) => x.t);
  const mapped = await Promise.all(matching.map((t) => toAssistantThread(session, t, pinnedSet.has(t.id))));
  const limit = opts.limit && opts.limit > 0 ? opts.limit : ASSISTANT_THREAD_DEFAULT_LIMIT;
  return sortAssistantThreads(mapped).slice(0, limit);
}

/** The thread, if it is in this company's assistant resource and tagged to the agent; else 404. */
export async function requireAssistantThread(
  session: TourbillonChatSession,
  agent: AgentLike,
  threadId: string,
): Promise<StoredThread> {
  const thread = await session.thread.getById({ threadId });
  if (!thread || !isAssistantThreadInScope(thread, agent)) {
    throw new AssistantThreadError('Thread not found', 404);
  }
  return thread;
}

const notFound = () => new AssistantThreadError('Thread not found', 404);

export async function updateAssistantThread(
  session: TourbillonChatSession,
  agent: AgentLike,
  threadId: string,
  changes: { title?: string; pinned?: boolean; read?: boolean },
  viewerKey: string,
): Promise<AssistantThread> {
  await requireAssistantThread(session, agent, threadId);
  if (changes.title !== undefined || changes.pinned !== undefined) assertAgentWritable(agent);

  // Each change is one statement scoped to (thread, resource, agent): no read-modify-write.
  if (changes.title !== undefined) {
    if (!(await renameAssistantThreadRow(threadScope(agent, threadId), changes.title))) throw notFound();
  }
  if (changes.pinned === true) {
    if (!(await pinAssistantThread(pinScope(agent, viewerKey), threadId))) {
      throw new AssistantThreadError(`Pin limit reached (${ASSISTANT_MAX_PINS_PER_AGENT} threads per agent)`, 409);
    }
  } else if (changes.pinned === false) {
    await unpinAssistantThread(pinScope(agent, viewerKey), threadId);
  }
  if (changes.read) {
    const [last] = await session.thread.listMessages({ threadId, limit: 1 });
    if (last && !(await markAssistantThreadReadRow(threadScope(agent, threadId), last.id))) throw notFound();
  }

  const pinned = (await listPinnedAssistantThreadIds(pinScope(agent, viewerKey))).includes(threadId);
  return toAssistantThread(session, await requireAssistantThread(session, agent, threadId), pinned);
}

/** New thread tagged to the agent (`kind: 'chat'`, `contextType: 'free'`, `agentId`). */
export async function createAssistantThread(
  session: TourbillonChatSession,
  agent: AgentLike,
  opts: { title?: string } = {},
): Promise<AssistantThread> {
  assertAgentWritable(agent);
  const thread = await session.thread.create({ title: opts.title });
  const tags: Record<string, string> = { ...ASSISTANT_THREAD_TAGS, agentId: agent.id };
  for (const [key, value] of Object.entries(tags)) {
    await session.thread.setSettingOn({ threadId: thread.id, key, value });
  }
  return toAssistantThread(session, await requireAssistantThread(session, agent, thread.id), false);
}
