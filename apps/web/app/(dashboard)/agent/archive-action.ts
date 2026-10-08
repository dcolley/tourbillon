'use server';

import { revalidatePath } from 'next/cache';
import { archiveAgent } from '@/lib/agent-archive';
import { getActiveCompanyOrNull, requireBoardSession } from '@/lib/company';

export type ArchiveAgentActionResult =
  | {
      ok: true;
      /** false: the agent was already archived (no-op success). */
      changed: boolean;
      /** Runs stopped by this archive (aborted by the scheduler or recorded cancelled). */
      runsStopped: number;
      timerSync: 'synced' | 'deferred';
    }
  | { ok: false; status: 400 | 401 | 404 | 500; error: string };

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
    return {
      ok: true,
      changed: result.changed,
      runsStopped: result.runs.filter((r) => r.outcome !== 'already_finished').length,
      timerSync: result.timerSync,
    };
  } catch {
    return { ok: false, status: 500, error: 'Failed to archive agent.' };
  }
}
