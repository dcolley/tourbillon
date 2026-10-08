/**
 * UX-2: pure logic for the agent detail page's Active/Inactive status chip.
 *
 * The chip reflects agents.status only: 'active' → Active, 'paused' → Inactive (setAgentActive
 * stores "inactive" as status 'paused'). The heartbeat timer (runtimeConfig.heartbeat.enabled,
 * "Timer off") is a separate setting: it never changes what the chip shows, and the toggle never
 * changes it. archived / pending_approval keep the read-only badge.
 */

export type ChipInFlightHeartbeat = { id: string; status: 'queued' | 'running' } | null;

export type AgentActiveToggleResult =
  | { ok: true; active: boolean; status: string }
  | { ok: false; status: 400 | 500; error: string };

export const AGENT_ACTIVE_TOGGLE_FALLBACK_ERROR = 'Failed to update agent status.';

/** Only active ↔ inactive agents get the clickable chip. */
export function canToggleAgentChip(status: string): boolean {
  return status === 'active' || status === 'paused';
}

export function isAgentChipActive(status: string): boolean {
  return status === 'active';
}

export function agentChipLabel(active: boolean): 'Active' | 'Inactive' {
  return active ? 'Active' : 'Inactive';
}

/**
 * Accessible name: the visible text first, then the action a click performs, so screen readers
 * and voice control hear what sighted users see (WCAG 2.5.3 label in name): "Active, deactivate
 * agent" / "Inactive, activate agent".
 */
export function agentChipAccessibleName(
  active: boolean,
): 'Active, deactivate agent' | 'Inactive, activate agent' {
  return active ? 'Active, deactivate agent' : 'Inactive, activate agent';
}

/** Confirm only when deactivating an agent whose heartbeat is running (not queued, not activating). */
export function shouldConfirmAgentToggle(currentlyActive: boolean, inFlight: ChipInFlightHeartbeat): boolean {
  return currentlyActive && inFlight?.status === 'running';
}

/**
 * Optimistic toggle: show `next` immediately, call the server, roll back to `current` and report
 * the error if the call fails or throws (a thrown call covers network errors and a refused board
 * session). On success the chip settles on the server's value.
 */
export async function runOptimisticAgentToggle(opts: {
  current: boolean;
  next: boolean;
  apply: (active: boolean) => void;
  call: (active: boolean) => Promise<AgentActiveToggleResult>;
  onError: (message: string) => void;
}): Promise<boolean> {
  const { current, next, apply, call, onError } = opts;
  apply(next);
  let result: AgentActiveToggleResult;
  try {
    result = await call(next);
  } catch {
    result = { ok: false, status: 500, error: AGENT_ACTIVE_TOGGLE_FALLBACK_ERROR };
  }
  if (!result.ok) {
    apply(current);
    onError(result.error || AGENT_ACTIVE_TOGGLE_FALLBACK_ERROR);
    return false;
  }
  apply(result.active);
  return true;
}
