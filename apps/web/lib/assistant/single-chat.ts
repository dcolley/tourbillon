/**
 * ASYNC-0: one conversation per agent in the assistant view.
 *
 * The agent path (`/assistant/<url key>`) is the only chat URL. It opens the agent's current
 * conversation: its pinned active thread (Slice B, lib/assistant/active-thread.ts; GET
 * /api/assistant/agents/[agentId]/threads → `initialThreadId`), and a first thread is created only
 * when there is none.
 *
 * Clear chat starts a fresh conversation: it creates a new Mastra thread for the agent through the
 * assistant thread API (POST …/threads), which pins it as the active thread (Slice B) and moves the
 * agent's idle AgentController session onto it, so Observational Memory (thread-scoped) continues on
 * the new conversation. Activity on an earlier thread never brings it back. Earlier threads are kept
 * in storage but no longer listed or reachable in the assistant view (it has no thread lists).
 * The resource id stays the company's free-chat resource.
 */
import { assistantAgentPath } from './sidebar';
import {
  resolveAgentObservationalMemory,
  resolveChatObservationalMemory,
  type AgentRuntimeConfig,
  type CompanySettings,
} from '@tourbillon/shared';

/** The agent's chat (its one conversation). */
export function agentChatPath(agentUrlKey: string): string {
  return assistantAgentPath(agentUrlKey);
}

/** The agent's Observational Memory settings (Control Pane → agent → Overview → Observational Memory). */
export function agentOmSettingsHref(agentUrlKey: string): string {
  return `/agent/${encodeURIComponent(agentUrlKey)}?view=overview&config=om`;
}

/** ASYNC-0 (Slice B): the agent's Observational Memory mode as the chat shows it (read-only). */
export interface AssistantOmSummary {
  /** The agent's own setting (Control Pane → Observational Memory). */
  mode: 'inherit' | 'on' | 'off';
  /** Whether OM actually runs for the agent (mode resolved against company settings, model configured). */
  active: boolean;
  /**
   * CONCIERGE-OM B1: whether OM runs for HEARTBEATS (resolveAgentObservationalMemory). Chat
   * forces OM on (`resolveChatObservationalMemory`), so `active` can be true while heartbeats
   * are off — the menu label says so instead of "Off" / "Inherit (off)". Absent on older payloads.
   */
  heartbeatActive?: boolean;
}

/**
 * CONCIERGE-OM B1: build the chat ⋯ menu summary. `active` MUST come from the CHAT resolver
 * (free-chat always attempts OM), never the heartbeat resolver — that mismatch was B1.
 * `heartbeatActive` keeps the honest copy when chat runs OM but heartbeats don't.
 */
export function chatOmSummary(
  companySettings: CompanySettings | null | undefined,
  agentRuntime: AgentRuntimeConfig | null | undefined,
): AssistantOmSummary {
  const mode = agentRuntime?.observationalMemory?.mode ?? 'inherit';
  return {
    mode,
    active: resolveChatObservationalMemory(companySettings, agentRuntime) !== null,
    heartbeatActive: resolveAgentObservationalMemory(companySettings, agentRuntime) !== null,
  };
}

export function isAssistantOmSummary(value: unknown): value is AssistantOmSummary {
  const v = value as Partial<AssistantOmSummary> | null;
  return Boolean(v) && (v!.mode === 'inherit' || v!.mode === 'on' || v!.mode === 'off') && typeof v!.active === 'boolean';
}

/** "Observational Memory: On", "… Off", "… Inherit (on)", "… On (not configured)", "… On in chat · heartbeats Off". */
export function agentOmMenuLabel(om: AssistantOmSummary | null | undefined): string {
  const base = 'Observational Memory';
  if (!om) return base;
  // CONCIERGE-OM B1: chat forces OM on, so "active" is the CHAT state. When chat runs OM but
  // heartbeats don't, say so — "Off" / "Inherit (off)" here would contradict the running chat.
  if (om.active && om.heartbeatActive === false) return `${base}: On in chat · heartbeats Off`;
  if (om.mode === 'off') return `${base}: Off`;
  if (om.mode === 'on') return `${base}: ${om.active ? 'On' : 'On (not configured)'}`;
  return `${base}: Inherit (${om.active ? 'on' : 'off'})`;
}

export type ClearChatResult =
  | { ok: true; threadId: string; observationalMemory?: AssistantOmSummary }
  | { ok: false; error: string };

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
  let body: { thread?: { id?: unknown }; observationalMemory?: unknown; error?: unknown } = {};
  try {
    body = ((await res.json()) as typeof body) ?? {};
  } catch {
    /* not JSON */
  }
  if (!res.ok) return { ok: false, error: typeof body.error === 'string' && body.error ? body.error : 'Could not clear the chat' };
  const id = body.thread?.id;
  if (typeof id !== 'string' || !id) return { ok: false, error: 'Could not clear the chat' };
  return isAssistantOmSummary(body.observationalMemory)
    ? { ok: true, threadId: id, observationalMemory: body.observationalMemory }
    : { ok: true, threadId: id };
}

export interface AgentChatMenuItem {
  id: 'clear' | 'om';
  label: string;
  disabled?: boolean;
  /** Why it is disabled, or (links) where it goes; shown as its title. */
  hint?: string;
  href?: string;
}

/**
 * The agent chat ⋯ menu: Clear chat, and the agent's Observational Memory (its current mode; the
 * item links to the settings in Control Pane, where it is edited).
 */
export function agentChatMenuItems(input: {
  agentUrlKey: string;
  runOpen: boolean;
  clearing?: boolean;
  observationalMemory?: AssistantOmSummary | null;
}): AgentChatMenuItem[] {
  const clearHint = input.runOpen ? 'Stop or wait for the current reply first' : input.clearing ? 'Clearing…' : undefined;
  return [
    { id: 'clear', label: 'Clear chat', disabled: Boolean(clearHint), ...(clearHint ? { hint: clearHint } : {}) },
    {
      id: 'om',
      label: agentOmMenuLabel(input.observationalMemory),
      hint: 'Change in Control Pane',
      href: agentOmSettingsHref(input.agentUrlKey),
    },
  ];
}
