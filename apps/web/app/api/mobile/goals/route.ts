import { NextRequest, NextResponse } from 'next/server';
import { listGoalsForCompany, type GoalStatus } from '@/lib/goals';
import { requireMobileCompany, toJson } from '@/lib/mobile-session';

export async function GET(req: NextRequest) {
  const auth = await requireMobileCompany(req);
  if ('error' in auth) return auth.error;

  try {
    const statusParam = req.nextUrl.searchParams.get('status') ?? 'all';
    const status = (['active', 'completed', 'archived', 'all'] as const).includes(
      statusParam as GoalStatus | 'all',
    )
      ? (statusParam as GoalStatus | 'all')
      : 'all';
    const goals = await listGoalsForCompany(auth.company.id, status);
    return NextResponse.json({ goals: toJson(goals) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list goals';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
