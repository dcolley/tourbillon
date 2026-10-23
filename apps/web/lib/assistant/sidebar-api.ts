/**
 * UI-2b: browser client for the assistant sidebar API (UI-2 server, #155):
 *   GET   /api/assistant/agents
 *   GET   /api/assistant/agents/[agentId]/threads[?q=&limit=]
 *   POST  /api/assistant/agents/[agentId]/threads            { title? }
 *   PATCH /api/assistant/agents/[agentId]/threads/[threadId] { title?, pinned?, read? }
 * `agentId` accepts the agent id or url key; the sidebar uses the url key (same as page URLs).
 */
import { assistantAgentPath, type AssistantAgent, type AssistantThread } from './sidebar';

export class AssistantApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** From Retry-After on 429 (thread creation limit). */
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'AssistantApiError';
  }
}

export interface AssistantAgentsResponse {
  companyId: string;
  agents: AssistantAgent[];
}

export interface AssistantThreadsResponse {
  agentId: string;
  threads: AssistantThread[];
  /** Thread to open when the agent is selected; null = start a new one. */
  initialThreadId: string | null;
}

export type AssistantThreadPatch = { title?: string; pinned?: boolean; read?: true };

/** Link to the chat view: `/assistant/<agent-url-key>[/<threadId>]` (see lib/assistant/route.ts). */
export function assistantChatHref(agentUrlKey: string, threadId?: string | null): string {
  return assistantAgentPath(agentUrlKey, threadId);
}

export function createAssistantSidebarApi(fetchImpl: typeof fetch = (...args) => fetch(...args)) {
  async function call<T>(url: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        ...init,
        headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
        cache: 'no-store',
      });
    } catch {
      throw new AssistantApiError('Network error; check your connection and try again', 0);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* empty or not JSON */
    }
    if (!res.ok) {
      const msg = (body as { error?: unknown } | null)?.error;
      const retry = Number(res.headers.get('Retry-After'));
      throw new AssistantApiError(
        typeof msg === 'string' && msg ? msg : `Request failed (${res.status})`,
        res.status,
        Number.isFinite(retry) && retry > 0 ? retry : undefined,
      );
    }
    return body as T;
  }
  const agentPath = (agentKey: string) => `/api/assistant/agents/${encodeURIComponent(agentKey)}/threads`;

  return {
    listAgents: () => call<AssistantAgentsResponse>('/api/assistant/agents'),
    listThreads: (agentKey: string, opts: { q?: string; limit?: number } = {}) => {
      const q = new URLSearchParams();
      if (opts.q) q.set('q', opts.q);
      if (opts.limit) q.set('limit', String(opts.limit));
      const qs = q.toString();
      return call<AssistantThreadsResponse>(`${agentPath(agentKey)}${qs ? `?${qs}` : ''}`);
    },
    createThread: async (agentKey: string, title?: string) =>
      (
        await call<{ thread: AssistantThread }>(agentPath(agentKey), {
          method: 'POST',
          body: JSON.stringify(title ? { title } : {}),
        })
      ).thread,
    updateThread: async (agentKey: string, threadId: string, patch: AssistantThreadPatch) =>
      (
        await call<{ thread: AssistantThread }>(`${agentPath(agentKey)}/${encodeURIComponent(threadId)}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        })
      ).thread,
  };
}

export type AssistantSidebarApi = ReturnType<typeof createAssistantSidebarApi>;
