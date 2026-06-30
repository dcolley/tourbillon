import { NextRequest, NextResponse } from 'next/server';
import { validateRunToken } from '@/lib/auth/run-token';
import { logAgentApiRequest, logAgentApiResponse } from '@/lib/agent-api-trace';
import { getGoalDetailForAgent, updateGoal, GoalValidationError } from '@/lib/goals';

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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string; goalId: string }> },
) {
  const { companyId, goalId } = await params;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return unauthorized();
  const runCtx = validateRunToken(token);
  if (!runCtx) return unauthorized();
  if (runCtx.companyId !== companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = (await req.json()) as {
    title?: string;
    description?: string | null;
    status?: string;
    ownerAgentId?: string | null;
  };

  logAgentApiRequest(
    `/api/companies/${companyId}/goals/${goalId}`,
    'PATCH',
    runCtx,
    { goalId },
  );

  try {
    const goal = await updateGoal(goalId, body, companyId);
    if (goal.companyId !== companyId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    logAgentApiResponse(
      `/api/companies/${companyId}/goals/${goalId}`,
      'PATCH',
      runCtx,
      200,
      { goalId: goal.id },
    );
    return NextResponse.json(goal);
  } catch (err) {
    if (err instanceof GoalValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
