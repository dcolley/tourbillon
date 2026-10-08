import { NextRequest, NextResponse } from 'next/server';
import { archiveAgent } from '@/lib/agent-archive';
import { requireBoardCompany } from '@/lib/board-route-auth';
import { resolveAgentTimerSchedule, type AgentRuntimeConfig } from '@tourbillon/shared';

/**
 * POST /api/agents/:agentId/archive — board 'Archive agent' (permanent). :agentId is the agent's
 * id or urlKey.
 * - Board only (#106 requireBoardCompany): agent run/chat bearer → 403; no board JWT/session → 401.
 * - Scoped to the board's company: another company's agent → 404 (same as a missing one).
 * - Sets archived, turns the heartbeat timer off, stops the in-flight run (cancelled,
 *   agent_archived). Already archived → 200 { changed: false } (idempotent).
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ agentId: string }> },
): Promise<NextResponse> {
  const guard = await requireBoardCompany(req);
  if (!guard.ok) return guard.response;

  try {
    const { agentId } = await context.params;
    const result = await archiveAgent(agentId, guard.value.id);
    if (!result) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    return NextResponse.json({
      archived: result.agent.status === 'archived',
      changed: result.changed,
      agentId: result.agent.id,
      // Archived agents never keep a timer (resolveAgentTimerSchedule → inactive).
      heartbeatTimerActive: resolveAgentTimerSchedule({
        status: result.agent.status,
        heartbeat: (result.agent.runtimeConfig as AgentRuntimeConfig | null)?.heartbeat,
      }).active,
      timerSync: result.timerSync,
      runs: result.runs,
    });
  } catch {
    return NextResponse.json({ error: 'Failed to archive agent' }, { status: 500 });
  }
}
