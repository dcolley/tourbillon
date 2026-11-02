/**
 * AGENT-AVATAR-UI: the two independent presence dots. Pure mappers, no React.
 *
 * Derek's rule: TWO separate indicators, never one stacked priority:
 *  1. **Avatar dot** — activity only: green = working (a heartbeat run is in flight),
 *     yellow = waiting (board approval / human input pending), no dot when idle.
 *     Unread is NEVER on the avatar.
 *  2. **List-item (row) dot** — unread only: blue = unread messages for that agent,
 *     no dot when nothing is unread.
 * Both may show at the same time (green on the avatar + blue on the row is valid).
 *
 * Signal mapping (existing Tourbillon signals, no second presence bus):
 *  - working: `heartbeat_runs.status = 'running'` for the agent (listAssistantAgents).
 *  - waiting: `approvals.status = 'pending'` requested by the agent ("waiting on you").
 *  - unread: any of the agent's assistant threads has `isThreadUnread` (last message is the
 *    agent's and the viewer's read marker is not on it) — see lib/assistant/sidebar.ts.
 *
 * Within the avatar dot, `working` and `waiting` are states of the SAME activity signal, so the
 * dot can only show one colour: a run in flight wins (it is the more immediate signal). This
 * tie-break never couples the avatar dot to the unread dot — that independence is what
 * `listUnreadDot` guarantees and the tests pin.
 */

export type AvatarActivityDot = 'working' | 'waiting' | null;

/** Raw activity signals (from the assistant agents API; kept unstacked on purpose). */
export interface AgentActivitySignals {
  /** A heartbeat run is currently in flight for this agent. */
  running: boolean;
  /** The agent is waiting on a human (pending board approval / input). */
  waiting: boolean;
}

/** The avatar's activity dot: green when working, yellow when waiting, nothing when idle. */
export function avatarActivityDot(signals: AgentActivitySignals): AvatarActivityDot {
  if (signals.running) return 'working';
  if (signals.waiting) return 'waiting';
  return null;
}

/** The row's unread dot: blue when the agent has unread messages, nothing otherwise. */
export function listUnreadDot(unread: boolean): 'unread' | null {
  return unread ? 'unread' : null;
}

/** Tailwind fill for each dot (activity: emerald/amber to match the status pills; unread: blue). */
export const AVATAR_ACTIVITY_DOT_CLASS: Record<Exclude<AvatarActivityDot, null>, string> = {
  working: 'bg-emerald-500',
  waiting: 'bg-amber-500',
};
export const LIST_UNREAD_DOT_CLASS = 'bg-blue-500';

/** Any of the agent's loaded threads unread (thread lists come from the sidebar store). */
export function agentHasUnread(threads: readonly { unread: boolean }[] | undefined): boolean {
  return (threads ?? []).some((t) => t.unread);
}
