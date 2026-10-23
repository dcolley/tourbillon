/**
 * AGUI-1b: gets an AG-UI-ready thread for an agent. The AG-UI endpoint never creates threads; they
 * come from the chat REST API, which tags them to the agent (metadata.agentId):
 *   1. POST /api/chat/[agentId]/sessions → the company's chat resource id;
 *   2. POST /api/chat/[agentId]/sessions/[resourceId]/threads → a new thread (unless one is given).
 * UI-2 replaces the "always a new thread" default with the sidebar's thread list.
 */
export const ASSISTANT_REST_SCOPE = 'assistant';
const TAGS = { kind: 'chat', contextType: 'free' } as const;

export interface AguiThreadRef {
  resourceId: string;
  threadId: string;
  agentName?: string;
}

export class AguiThreadBootstrapError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AguiThreadBootstrapError';
  }
}

async function failure(res: Response, fallback: string): Promise<AguiThreadBootstrapError> {
  let message = fallback;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === 'string' && body.error) message = body.error;
  } catch {
    /* not JSON */
  }
  return new AguiThreadBootstrapError(message, res.status);
}

export async function openAguiThread(opts: {
  agentId: string;
  /** Existing thread to reopen (must belong to this agent; the endpoint checks it on every request). */
  threadId?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<AguiThreadRef> {
  const f = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const agent = encodeURIComponent(opts.agentId);
  const json = { 'Content-Type': 'application/json' };

  const sessionRes = await f(`/api/chat/${agent}/sessions`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ tags: TAGS, sessionScope: ASSISTANT_REST_SCOPE }),
    signal: opts.signal,
  });
  if (!sessionRes.ok) throw await failure(sessionRes, 'Could not open the chat');
  const session = (await sessionRes.json()) as { resourceId?: unknown; agentName?: unknown };
  if (typeof session.resourceId !== 'string' || !session.resourceId) {
    throw new AguiThreadBootstrapError('Could not open the chat');
  }
  const agentName = typeof session.agentName === 'string' ? session.agentName : undefined;
  if (opts.threadId) return { resourceId: session.resourceId, threadId: opts.threadId, agentName };

  const threadRes = await f(
    `/api/chat/${agent}/sessions/${encodeURIComponent(session.resourceId)}/threads?sessionScope=${encodeURIComponent(ASSISTANT_REST_SCOPE)}`,
    { method: 'POST', headers: json, body: JSON.stringify({ title: 'New chat', tags: TAGS }), signal: opts.signal },
  );
  if (!threadRes.ok) throw await failure(threadRes, 'Could not start a new chat');
  const thread = (await threadRes.json()) as { id?: unknown };
  if (typeof thread.id !== 'string' || !thread.id) throw new AguiThreadBootstrapError('Could not start a new chat');
  return { resourceId: session.resourceId, threadId: thread.id, agentName };
}
