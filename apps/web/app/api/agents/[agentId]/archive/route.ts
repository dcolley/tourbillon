import { NextRequest, NextResponse } from 'next/server';
import { archiveAgent, getArchiveImpact } from '@/lib/agent-archive';
import { requireBoardCompany } from '@/lib/board-route-auth';
import { resolveAgentTimerSchedule, type AgentRuntimeConfig } from '@tourbillon/shared';

/**
 * POST /api/agents/:agentId/archive — board 'Archive agent' (permanent, no unarchive). :agentId is the agent's
 * id or urlKey.
 * - Board only (#106 requireBoardCompany): agent run/chat bearer → 403; no board JWT/session → 401.
 * - Scoped to the board's company: another company's agent → 404 (same as a missing one).
 * - Sets archived, turns the heartbeat timer off, rejects the agent's pending approvals
 *   ('Requesting agent archived'), unassigns its open issues, stops the in-flight run (cancelled,
 *   agent_archived). Already archived → 200 { changed: false }, zero counts (idempotent).
 * GET: what archiving would change now ({ pendingApprovals, openIssues }), same guard and scoping.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ agentId: string }> },
): Promise<NextResponse> {
  const guard = await requireBoardCompany(req);
  if (!guard.ok) return guard.response;
  let agentId: string | undefined;
  try {
    ({ agentId } = await context.params);
    const impact = await getArchiveImpact(agentId, guard.value.id);
    if (!impact) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    return NextResponse.json(impact);
  } catch (err) {
    console.error('[agent-archive] impact failed', {
      agentId,
      companyId: guard.value.id,
      error: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error',
    });
    return NextResponse.json({ error: 'Failed to load archive impact' }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ agentId: string }> },
): Promise<NextResponse> {
  const guard = await requireBoardCompany(req);
  if (!guard.ok) return guard.response;

  let agentId: string | undefined;
  try {
    ({ agentId } = await context.params);
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
      approvalsRejected: result.approvalsRejected,
      issuesUnassigned: result.issuesUnassigned,
    });
  } catch (err) {
    // Error name/message only: a driver error object can carry the query's parameters.
    console.error('[agent-archive] archive failed', {
      agentId,
      companyId: guard.value.id,
      error: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error',
    });
    return NextResponse.json({ error: 'Failed to archive agent' }, { status: 500 });
  }
}
