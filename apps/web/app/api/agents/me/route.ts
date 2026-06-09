import { NextRequest, NextResponse } from 'next/server';
import { db, agents, companies } from '@tourbillon/db';
import { eq, and } from 'drizzle-orm';
import { validateRunToken } from '@/lib/auth/run-token';
import { logAgentApiRequest, logAgentApiResponse } from '@/lib/agent-api-trace';

export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const runCtx = validateRunToken(token);
  if (!runCtx) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

  logAgentApiRequest('/api/agents/me', 'GET', runCtx);

  const agent = await db.query.agents.findFirst({
    where: and(eq(agents.id, runCtx.agentId), eq(agents.companyId, runCtx.companyId)),
    with: { company: true, reportsTo: true },
  });

  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const budgetRatio = agent.spentMonthlyTokens / agent.budgetMonthlyTokens;

  logAgentApiResponse('/api/agents/me', 'GET', runCtx, 200, {
    agentName: agent.name,
    status: agent.status,
    budgetExhausted: budgetRatio >= 1.0,
  });

  return NextResponse.json({
    id: agent.id,
    name: agent.name,
    role: agent.role,
    title: agent.title,
    companyId: agent.companyId,
    reportsToId: agent.reportsToId,
    reportsToName: agent.reportsTo?.name ?? null,
    budgetMonthlyTokens: agent.budgetMonthlyTokens,
    spentMonthlyTokens: agent.spentMonthlyTokens,
    budgetRatio,
    budgetWarning: budgetRatio >= 0.8,
    budgetExhausted: budgetRatio >= 1.0,
    status: agent.status,
  });
}
