'use server';

import { revalidatePath } from 'next/cache';
import { archiveAgent, getArchiveImpact } from '@/lib/agent-archive';
import { getActiveCompanyOrNull, requireBoardSession } from '@/lib/company';

export type ArchiveAgentActionResult =
  | {
      ok: true;
      /** false: the agent was already archived (no-op success). */
      changed: boolean;
      /** Runs stopped by this archive (aborted by the scheduler or recorded cancelled). */
      runsStopped: number;
      timerSync: 'synced' | 'deferred';
      /** Pending approvals rejected ('Requesting agent archived') and open issues unassigned. */
      approvalsRejected: number;
      issuesUnassigned: number;
    }
  | { ok: false; status: 400 | 401 | 404 | 500; error: string };

export type ArchiveImpactActionResult =
  | { ok: true; archived: boolean; pendingApprovals: number; openIssues: number }
  | { ok: false; status: 400 | 401 | 404 | 500; error: string };

/**
 * Confirm-dialog counts for 'Archive agent': the agent's pending approvals and open issues.
 * Board session, active company only (another company's agent → 404). Read only.
 */
export async function getArchiveImpactAction(agentId: string): Promise<ArchiveImpactActionResult> {
  await requireBoardSession();
  if (typeof agentId !== 'string' || !agentId.trim()) {
    return { ok: false, status: 400, error: 'Agent ID is required.' };
  }
  const company = await getActiveCompanyOrNull();
  if (!company) return { ok: false, status: 401, error: 'Unauthorized' };
  try {
    const impact = await getArchiveImpact(agentId, company.id);
    if (!impact) return { ok: false, status: 404, error: 'Agent not found.' };
    return {
      ok: true,
      archived: impact.archived,
      pendingApprovals: impact.pendingApprovals,
      openIssues: impact.openIssues,
    };
  } catch {
    return { ok: false, status: 500, error: 'Failed to load what archiving would change.' };
  }
}

/**
 * Board 'Archive agent' (agent detail page). Board session first (#105 B1), then the agent is
 * resolved inside the board's active company only (another company's agent → 404). Sets the agent
 * archived, turns its heartbeat timer off and stops its in-flight run (see lib/agent-archive.ts).
 * Already archived → ok with changed: false. Agent run/chat bearers never reach this: proxy.ts
 * answers 401 and requireBoardSession / getActiveCompanyOrNull refuse agent tokens.
 */
export async function archiveAgentAction(
  agentId: string,
  urlKey?: string,
): Promise<ArchiveAgentActionResult> {
  await requireBoardSession();

  if (typeof agentId !== 'string' || !agentId.trim()) {
    return { ok: false, status: 400, error: 'Agent ID is required.' };
  }

  const company = await getActiveCompanyOrNull();
  if (!company) return { ok: false, status: 401, error: 'Unauthorized' };

  try {
    const result = await archiveAgent(agentId, company.id);
    if (!result) return { ok: false, status: 404, error: 'Agent not found.' };
    revalidatePath('/agent');
    if (urlKey) revalidatePath(`/agent/${urlKey}`);
    if (result.approvalsRejected > 0) revalidatePath('/approval');
    if (result.issuesUnassigned > 0) revalidatePath('/issue');
    return {
      ok: true,
      changed: result.changed,
      runsStopped: result.runs.filter((r) => r.outcome !== 'already_finished').length,
      timerSync: result.timerSync,
      approvalsRejected: result.approvalsRejected,
      issuesUnassigned: result.issuesUnassigned,
    };
  } catch {
    return { ok: false, status: 500, error: 'Failed to archive agent.' };
  }
}
