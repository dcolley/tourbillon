import { NextRequest, NextResponse } from 'next/server';
import { validateRunToken } from '@/lib/auth/run-token';
import { logAgentApiRequest, logAgentApiResponse } from '@/lib/agent-api-trace';
import { getGoalDetailForAgent } from '@/lib/goals';

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string; goalId: string }> }
) {
  const { companyId, goalId } = await params;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return unauthorized();
  const runCtx = validateRunToken(token);
  if (!runCtx) return unauthorized();
  if (runCtx.companyId !== companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  logAgentApiRequest(
    `/api/companies/${companyId}/goals/${goalId}`,
    'GET',
    runCtx,
    { goalId: goalId }
  );

  const detail = await getGoalDetailForAgent(goalId, companyId);
  if (!detail) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  logAgentApiResponse(
    `/api/companies/${companyId}/goals/${goalId}`,
    'GET',
    runCtx,
    200,
    { issueCount: detail.issues.length, needsAttention: detail.needsAttention }
  );

  return NextResponse.json(detail);
}
