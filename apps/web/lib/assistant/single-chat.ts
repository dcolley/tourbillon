/**
 * ASYNC-0 (Slice A): one conversation per agent in the assistant view.
 *
 * The agent path (`/assistant/<url key>`) is the only chat URL. It opens the agent's current
 * conversation: its latest thread by activity (GET /api/assistant/agents/[agentId]/threads →
 * `initialThreadId`), and a first thread is created only when there is none.
 *
 * Clear chat starts a fresh conversation: it creates a new Mastra thread for the agent through the
 * existing assistant thread API (POST …/threads). The new thread is the latest one, so it becomes the
 * agent's current conversation from then on (also after a reload). Earlier threads are kept in
 * storage but no longer listed or reachable in the assistant view (it has no thread lists).
 * Slice A does not touch Observational Memory: the resource id stays the company's free-chat
 * resource. Slice B owns OM on the single conversation and any Clear ↔ OM resource behaviour.
 */
import { assistantAgentPath } from './sidebar';

/** The agent's chat (its one conversation). */
export function agentChatPath(agentUrlKey: string): string {
  return assistantAgentPath(agentUrlKey);
}

/** The agent's Observational Memory settings (Control Pane → agent → Overview → Observational Memory). */
export function agentOmSettingsHref(agentUrlKey: string): string {
  return `/agent/${encodeURIComponent(agentUrlKey)}?view=overview&config=om`;
}

export type ClearChatResult = { ok: true; threadId: string } | { ok: false; error: string };

/** Start a fresh conversation for the agent (a new thread that becomes its current one). */
export async function clearAgentChat(agentId: string, opts: { fetch?: typeof fetch } = {}): Promise<ClearChatResult> {
  const f = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  let res: Response;
  try {
    res = await f(`/api/assistant/agents/${encodeURIComponent(agentId)}/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      credentials: 'same-origin',
    });
  } catch {
    return { ok: false, error: 'Could not clear the chat' };
  }
  let body: { thread?: { id?: unknown }; error?: unknown } = {};
  try {
    body = ((await res.json()) as typeof body) ?? {};
  } catch {
    /* not JSON */
  }
  if (!res.ok) return { ok: false, error: typeof body.error === 'string' && body.error ? body.error : 'Could not clear the chat' };
  const id = body.thread?.id;
  return typeof id === 'string' && id ? { ok: true, threadId: id } : { ok: false, error: 'Could not clear the chat' };
}

export interface AgentChatMenuItem {
  id: 'clear' | 'om';
  label: string;
  disabled?: boolean;
  /** Why it is disabled, shown as its title. */
  hint?: string;
  href?: string;
}

/** The agent chat ⋯ menu: Clear chat, and the agent's Observational Memory settings. */
export function agentChatMenuItems(input: { agentUrlKey: string; runOpen: boolean; clearing?: boolean }): AgentChatMenuItem[] {
  const clearHint = input.runOpen ? 'Stop or wait for the current reply first' : input.clearing ? 'Clearing…' : undefined;
  return [
    { id: 'clear', label: 'Clear chat', disabled: Boolean(clearHint), ...(clearHint ? { hint: clearHint } : {}) },
    { id: 'om', label: 'Observational Memory', href: agentOmSettingsHref(input.agentUrlKey) },
  ];
}
