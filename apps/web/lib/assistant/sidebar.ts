/**
 * UI-2: data model for the assistant sidebar (agents by section, their threads).
 * Pure helpers shared by the assistant API routes and the sidebar client (UI-2b).
 */

/** Most threads one user may pin per agent (pinned threads are loaded one by one). */
export const ASSISTANT_MAX_PINS_PER_AGENT = 50;

export type AssistantAgentStatus = 'idle' | 'running' | 'waiting';

export interface AssistantAgent {
  id: string;
  name: string;
  role: string;
  title: string;
  urlKey: string;
  icon: string | null;
  reportsToId: string | null;
  active: boolean;
  status: AssistantAgentStatus;
  /** Pending board approvals requested by this agent. */
  pendingApprovals: number;
}

export interface AssistantThread {
  id: string;
  agentId: string | null;
  title: string;
  pinned: boolean;
  unread: boolean;
  /** Last message time (falls back to thread creation), ISO string. */
  lastActivityAt: string | null;
  createdAt: string | null;
}

export interface AssistantTeam {
  role: string;
  agents: AssistantAgent[];
}

export interface AssistantSidebarSections {
  pinned: AssistantAgent[];
  myAgents: AssistantAgent[];
  teams: AssistantTeam[];
}

/**
 * Thread metadata keys written by the assistant view (kept out of chat thread tags).
 * Pins are per user and live in `assistant_thread_pins`, not in thread metadata.
 */
export const ASSISTANT_THREAD_READ_MESSAGE_KEY = 'assistantReadMessageId';
export const ASSISTANT_THREAD_METADATA_KEYS: readonly string[] = [ASSISTANT_THREAD_READ_MESSAGE_KEY];

/** "waiting on you" wins over "running": the user is the blocker. */
export function agentChatStatus(input: { running: boolean; pendingApprovals: number }): AssistantAgentStatus {
  if (input.pendingApprovals > 0) return 'waiting';
  if (input.running) return 'running';
  return 'idle';
}

const byName = (a: AssistantAgent, b: AssistantAgent) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);

/**
 * Group agents for the sidebar.
 * - Pinned: agents the user pinned, in pin order (unknown ids ignored).
 * - My agents: agents reporting straight to the board (no `reportsToId`, or a manager that is
 *   not in this company list).
 * - Teams: every other agent, grouped by role (roles A–Z, agents A–Z).
 * An agent appears in exactly one section.
 */
export function groupSidebarAgents(
  agents: readonly AssistantAgent[],
  opts: { pinnedAgentIds?: readonly string[] } = {},
): AssistantSidebarSections {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const pinnedIds = [...new Set(opts.pinnedAgentIds ?? [])].filter((id) => byId.has(id));
  const pinnedSet = new Set(pinnedIds);
  const pinned = pinnedIds.map((id) => byId.get(id)!);

  const myAgents: AssistantAgent[] = [];
  const teamMap = new Map<string, AssistantAgent[]>();
  for (const agent of agents) {
    if (pinnedSet.has(agent.id)) continue;
    if (!agent.reportsToId || !byId.has(agent.reportsToId)) {
      myAgents.push(agent);
      continue;
    }
    const role = agent.role.trim() || 'custom';
    const list = teamMap.get(role) ?? [];
    list.push(agent);
    teamMap.set(role, list);
  }

  const teams = [...teamMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([role, list]) => ({ role, agents: [...list].sort(byName) }));

  return { pinned, myAgents: myAgents.sort(byName), teams };
}

const activityTime = (t: Pick<AssistantThread, 'lastActivityAt' | 'createdAt'>) =>
  Date.parse(t.lastActivityAt ?? t.createdAt ?? '') || 0;

/** Pinned threads first, then most recent activity first. */
export function sortAssistantThreads<T extends AssistantThread>(threads: readonly T[]): T[] {
  return [...threads].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || activityTime(b) - activityTime(a) || a.id.localeCompare(b.id),
  );
}

/** Case-insensitive title search; every whitespace-separated term must match. */
export function filterThreadsByTitle<T extends Pick<AssistantThread, 'title'>>(
  threads: readonly T[],
  query: string | null | undefined,
): T[] {
  const terms = (query ?? '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...threads];
  return threads.filter((t) => {
    const title = (t.title ?? '').toLocaleLowerCase();
    return terms.every((term) => title.includes(term));
  });
}

/** Most recent threads across agents for the "Recent threads" section. */
export function recentThreads<T extends AssistantThread>(threads: readonly T[], limit = 10): T[] {
  return [...threads].sort((a, b) => activityTime(b) - activityTime(a) || a.id.localeCompare(b.id)).slice(0, Math.max(0, limit));
}

/**
 * Which thread opens when an agent is selected: its latest own thread by activity
 * (ignoring pins), else null for "start a new thread".
 */
export function pickInitialThread<T extends AssistantThread>(threads: readonly T[], agentId: string): T | null {
  const own = threads.filter((t) => t.agentId === agentId);
  return recentThreads(own, 1)[0] ?? null;
}

/** Unread: the newest message is from the agent and the user has not opened the thread since. */
export function isThreadUnread(input: {
  lastMessageId: string | null | undefined;
  lastMessageRole: string | null | undefined;
  readMessageId: unknown;
}): boolean {
  if (!input.lastMessageId) return false;
  if (input.lastMessageRole !== 'assistant') return false;
  return input.readMessageId !== input.lastMessageId;
}

/** Assistant view routes (pages land in UI-2b): `/assistant/{agentUrlKey}[/{threadId}]`. */
export function assistantAgentPath(agentUrlKey: string, threadId?: string | null): string {
  const base = `/assistant/${encodeURIComponent(agentUrlKey)}`;
  return threadId ? `${base}/${encodeURIComponent(threadId)}` : base;
}
