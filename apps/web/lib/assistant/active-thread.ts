/**
 * ASYNC-0 (Slice B): the agent's one continuous Assistant conversation.
 *
 * Product rule: the active thread is pinned explicitly (assistant_active_threads, one row per
 * company + agent), never inferred from activity. So:
 * - opening the chat (GET …/threads → `initialThreadId`) returns the pinned thread; only an agent
 *   with no (or a vanished) pinned thread falls back to its latest thread, which is then pinned;
 * - Clear chat (POST …/threads) creates a fresh thread and pins it, so a later message on, or a
 *   tool result landing in, a pre-Clear thread can never make that thread current again;
 * - Clear also moves the agent's idle AG-UI AgentController session onto the new thread, so the
 *   session (and Observational Memory, which is thread-scoped: packages/mastra getAgentMemory) is on
 *   the new conversation before its first run. A session whose run is open or parked on a card keeps
 *   its thread until that run ends (stopping it is offered in the chat); every run also binds the
 *   session to the run's thread (app/api/agui/[agentId]/route.ts bindThread).
 * The resource id stays the company's free-chat resource (`company-<id>:chat:free`); with
 * thread-scoped OM the OM record is keyed by (that resource, the active thread).
 */
import { parseCompanySettings, type AgentRuntimeConfig } from '@tourbillon/shared';
import { getActiveCompany } from '@/lib/company';
import { listCachedChatControllersForAgent, type TourbillonChatSession } from '@/lib/chat';
import { aguiSessionScope } from '@/lib/agui/run-input';
import {
  claimActiveAssistantThread,
  getActiveAssistantThreadId,
  setActiveAssistantThread,
  type ActiveThreadScope,
} from '@/lib/assistant/thread-store';
import { assistantResourceId, isAssistantThreadInScope } from './threads';
import { pickInitialThread, type AssistantThread } from './sidebar';
import { chatOmSummary, type AssistantOmSummary } from './single-chat';

type AgentLike = { id: string; companyId: string; runtimeConfig?: unknown };

const activeScope = (agent: AgentLike): ActiveThreadScope => ({ companyId: agent.companyId, agentId: agent.id });

/** Where the agent's Assistant conversation (AgentController session + OM) lives for a thread. */
export function assistantConversationBinding(agent: AgentLike, threadId: string) {
  return { resourceId: assistantResourceId(agent.companyId), scope: aguiSessionScope(agent), threadId };
}

/**
 * The agent's active thread id: the pinned one while it still exists in scope, else (backfill) its
 * latest thread from `threads`, pinned now. Null when the agent has no thread (the client creates one).
 */
export async function resolveActiveAssistantThread(
  session: TourbillonChatSession,
  agent: AgentLike,
  threads: readonly AssistantThread[],
): Promise<string | null> {
  const scope = activeScope(agent);
  const pinned = await getActiveAssistantThreadId(scope);
  if (pinned) {
    const thread = await session.thread.getById({ threadId: pinned });
    if (thread && isAssistantThreadInScope(thread, agent)) return pinned;
  }
  const fallback = pickInitialThread(threads, agent.id)?.id ?? null;
  if (!fallback || fallback === pinned) return null;
  if (await claimActiveAssistantThread(scope, fallback, pinned)) return fallback;
  // Someone else pinned a thread meanwhile (e.g. a Clear): theirs wins.
  return (await getActiveAssistantThreadId(scope)) ?? fallback;
}

/**
 * Clear chat / first thread: pin `threadId` as the active thread and move the agent's idle AG-UI
 * sessions (every built controller: default and CHAT-5 model overrides) onto it.
 * Returns the number of sessions moved.
 */
export async function activateAssistantThread(agent: AgentLike, threadId: string): Promise<number> {
  await setActiveAssistantThread(activeScope(agent), threadId);
  return retargetAgentChatSessions(agent, threadId);
}

export async function retargetAgentChatSessions(agent: AgentLike, threadId: string): Promise<number> {
  const { resourceId, scope } = assistantConversationBinding(agent, threadId);
  let moved = 0;
  for (const controller of await listCachedChatControllersForAgent(agent.id)) {
    try {
      const session = await controller.getSessionByResource(resourceId, scope);
      if (!session || session.thread.getId() === threadId) continue;
      // An open run, or one parked on a card / approval, stays on its thread until it ends.
      if (session.getCurrentRunId()) continue;
      await session.thread.switch({ threadId });
      moved++;
    } catch (err) {
      // The next run binds the session to its thread anyway; Clear itself already succeeded.
      console.warn('[assistant] could not move the chat session to the new thread', err);
    }
  }
  return moved;
}

/** The agent's Observational Memory mode for the chat ⋯ menu (editing stays in Control Pane). */
export async function assistantOmSummary(agent: AgentLike): Promise<AssistantOmSummary> {
  const runtime = (agent.runtimeConfig ?? null) as AgentRuntimeConfig | null;
  let settings = null;
  try {
    const company = await getActiveCompany();
    if (company.id === agent.companyId) settings = parseCompanySettings(company.settings);
  } catch {
    /* no active company: resolve without company settings */
  }
  // B1: chat resolves OM through the CHAT resolver (free-chat forces OM on), never the
  // heartbeat resolver — the menu must match what chat actually runs.
  return chatOmSummary(settings, runtime);
}
