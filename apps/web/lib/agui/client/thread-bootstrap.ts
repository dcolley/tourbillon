/**
 * AGUI-1b: gets an AG-UI-ready thread for an agent. The AG-UI endpoint never creates threads; they
 * come from the assistant thread API (UI-2), which tags them to the agent (metadata.agentId):
 *   - a given thread id is checked first (GET /api/assistant/agents/[agentId]/threads/[threadId]),
 *     so a thread that is not the agent's fails when the chat opens, not on the first message;
 *   - otherwise the agent's initial thread is reused (GET …/threads → `initialThreadId`, its latest
 *     thread), and a new thread is created only when the agent has none (POST …/threads).
 */
const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Ids made only of dots would change the API path once the URL is normalised. */
const DOT_ONLY = /^\.+$/;

export function isUsableAguiId(value: string | undefined | null): value is string {
  return typeof value === 'string' && value.length > 0 && !DOT_ONLY.test(value);
}

export interface AguiThreadRef {
  threadId: string;
  /** True when this call created the thread (the agent had none). */
  created: boolean;
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

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function threadIdOf(body: Record<string, unknown>): string | undefined {
  const thread = body.thread as { id?: unknown } | undefined;
  return typeof thread?.id === 'string' && thread.id ? thread.id : undefined;
}

export async function openAguiThread(opts: {
  agentId: string;
  /** Existing thread to reopen; it must be one of the agent's threads. */
  threadId?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<AguiThreadRef> {
  const f = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  if (!isUsableAguiId(opts.agentId)) throw new AguiThreadBootstrapError('Agent not found', 404);
  const base = `/api/assistant/agents/${encodeURIComponent(opts.agentId)}/threads`;

  if (opts.threadId !== undefined) {
    if (!isUsableAguiId(opts.threadId)) throw new AguiThreadBootstrapError('Thread not found', 404);
    const res = await f(`${base}/${encodeURIComponent(opts.threadId)}`, { method: 'GET', signal: opts.signal });
    if (!res.ok) throw await failure(res, 'Could not open this chat');
    if (threadIdOf(await readJson(res)) !== opts.threadId) throw new AguiThreadBootstrapError('Could not open this chat');
    return { threadId: opts.threadId, created: false };
  }

  const listRes = await f(base, { method: 'GET', signal: opts.signal });
  if (!listRes.ok) throw await failure(listRes, 'Could not open the chat');
  const initial = (await readJson(listRes)).initialThreadId;
  if (typeof initial === 'string' && isUsableAguiId(initial)) return { threadId: initial, created: false };

  const createRes = await f(base, { method: 'POST', headers: JSON_HEADERS, body: '{}', signal: opts.signal });
  if (!createRes.ok) throw await failure(createRes, 'Could not start a new chat');
  const threadId = threadIdOf(await readJson(createRes));
  if (!threadId) throw new AguiThreadBootstrapError('Could not start a new chat');
  return { threadId, created: true };
}
