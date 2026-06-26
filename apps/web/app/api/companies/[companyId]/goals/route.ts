import { NextRequest, NextResponse } from 'next/server';
import { validateRunToken } from '@/lib/auth/run-token';
import { logAgentApiRequest, logAgentApiResponse } from '@/lib/agent-api-trace';
import { listGoalsForAgent, createGoal, GoalValidationError, type GoalStatus } from '@/lib/goals';

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> }
) {
  const { companyId } = await params;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return unauthorized();
  const runCtx = validateRunToken(token);
  if (!runCtx) return unauthorized();
  if (runCtx.companyId !== companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const statusParam = req.nextUrl.searchParams.get('status') ?? 'active';
  const statusFilter = (['active', 'completed', 'archived', 'all'] as const).includes(
    statusParam as GoalStatus | 'all'
  )
    ? (statusParam as GoalStatus | 'all')
    : 'active';

  logAgentApiRequest(`/api/companies/${companyId}/goals`, 'GET', runCtx, {
    status: statusFilter,
  });

  const goals = await listGoalsForAgent(companyId, statusFilter);

  logAgentApiResponse(`/api/companies/${companyId}/goals`, 'GET', runCtx, 200, {
    goalCount: goals.length,
    needsAttentionCount: goals.filter((g) => g.needsAttention).length,
  });

  return NextResponse.json({ goals });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const { companyId } = await params;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return unauthorized();
  const runCtx = validateRunToken(token);
  if (!runCtx) return unauthorized();
  if (runCtx.companyId !== companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = (await req.json()) as {
    title: string;
    description?: string;
    status?: string;
  };

  logAgentApiRequest(`/api/companies/${companyId}/goals`, 'POST', runCtx, { title: body.title });

  try {
    const goal = await createGoal({ ...body, companyId });
    logAgentApiResponse(`/api/companies/${companyId}/goals`, 'POST', runCtx, 201, {
      goalId: goal.id,
    });
    return NextResponse.json(goal, { status: 201 });
  } catch (err) {
    if (err instanceof GoalValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
