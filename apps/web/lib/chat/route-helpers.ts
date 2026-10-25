import { NextResponse } from 'next/server';
import { ActiveCompanyError } from '@/lib/company';
import {
  ChatAgentError,
  getChatSession,
  type TourbillonChatController,
  type TourbillonChatSession,
} from '@/lib/chat';
import { agentTokenConfigErrorResponse, isAgentTokenConfigError } from '@/lib/auth/agent-token-config';
import { isControlChatServerEnabled } from '@/lib/feature-flags';
import { threadProviderRefusedBody } from '@/lib/chat/thread-model';

export function chatErrorResponse(err: unknown): NextResponse {
  if (err instanceof ChatAgentError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof ActiveCompanyError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  // CHAT-5: the controller refused a thread's provider that is not available to the company.
  if (err instanceof Error && err.name === 'ChatProviderUnavailableError') {
    return NextResponse.json(threadProviderRefusedBody(), { status: 409 });
  }
  // Mastra rejects thread ids outside the session resource with "Thread not found: <id>".
  if (err instanceof Error && /^Thread not found\b/.test(err.message)) {
    return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
  }
  // #110: no/short TOURBILLON_AGENT_TOKEN_SECRET → 401 + server log (same as agent API routes).
  if (isAgentTokenConfigError(err)) {
    return agentTokenConfigErrorResponse('chat');
  }
  console.error('[chat-api]', err);
  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json({ error: message }, { status: 500 });
}

export function decodeResourceId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The agent fields chat scoping depends on. */
export type ChatScopeAgent = { id: string; companyId: string };

/** Every chat resource of a company starts with this prefix (see buildChatResourceId). */
export function chatResourcePrefix(companyId: string): string {
  return `company-${companyId}:chat:`;
}

/**
 * The resource id comes from the URL or the request body, so it must belong to the agent's
 * company (the active company, via resolveChatAgent). Anything else is reported as not found.
 */
export function requireChatResource(agent: ChatScopeAgent, resourceId: string): string {
  const prefix = chatResourcePrefix(agent.companyId);
  if (!resourceId.startsWith(prefix) || resourceId.length === prefix.length) {
    throw new ChatAgentError('Resource not found', 404);
  }
  return resourceId;
}

type ChatThreadRecord = { resourceId?: string; metadata?: unknown } | null | undefined;

/**
 * A thread is usable by an agent when it lives in the requested resource and is either the
 * agent's own thread (metadata.agentId) or an untagged shared thread.
 */
export function chatThreadVisibleTo(
  thread: ChatThreadRecord,
  agent: ChatScopeAgent,
  resourceId: string,
): boolean {
  if (!thread || thread.resourceId !== resourceId) return false;
  const owner = (thread.metadata as Record<string, unknown> | null | undefined)?.agentId;
  return owner === undefined || owner === null || owner === '' || owner === agent.id;
}

/** 404 unless the thread exists in the resource and is visible to the agent. */
export async function requireChatThread(
  session: TourbillonChatSession,
  agent: ChatScopeAgent,
  resourceId: string,
  threadId: string,
) {
  const thread = await session.thread.getById({ threadId });
  if (!thread || !chatThreadVisibleTo(thread, agent, resourceId)) {
    throw new ChatAgentError('Thread not found', 404);
  }
  return thread;
}

/**
 * Open (or resume) the chat session for a route, scoped to the agent's company.
 * - The resource must belong to the agent's company (404 otherwise).
 * - A session may bind a thread implicitly (for example the newest thread of the resource when a
 *   new session scope starts). When that thread belongs to another agent, the binding is dropped
 *   so the route never acts on it.
 * - An explicit threadId that exists but is not visible to the agent answers 404 before the
 *   session binds or switches to it.
 */
export async function openChatRouteSession(
  controller: TourbillonChatController,
  agent: Parameters<typeof getChatSession>[1],
  opts: {
    resourceId: string;
    threadId?: string;
    tags?: Record<string, string>;
    scope?: string;
  },
): Promise<TourbillonChatSession> {
  requireChatResource(agent, opts.resourceId);
  if (opts.threadId) {
    // Check an explicit thread before the session binds (or switches) to it.
    const target = await controller.queryThreadById({ threadId: opts.threadId });
    if (target && !chatThreadVisibleTo(target, agent, opts.resourceId)) {
      throw new ChatAgentError('Thread not found', 404);
    }
  }
  const session = await getChatSession(controller, agent, opts);
  const boundId = session.thread.getId();
  if (boundId) {
    const bound = await session.thread.getById({ threadId: boundId });
    if (bound && !chatThreadVisibleTo(bound, agent, opts.resourceId)) {
      session.thread.clear();
      if (opts.threadId) throw new ChatAgentError('Thread not found', 404);
    }
  }
  return session;
}

/**
 * The legacy Control Pane chat session routes are off unless isControlChatServerEnabled().
 * Returns the 404 to send when they are off (checked before anything else in the handler), or
 * null when the route may run.
 */
export function controlChatDisabledResponse(): NextResponse | null {
  if (isControlChatServerEnabled()) return null;
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

