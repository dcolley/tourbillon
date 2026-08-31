import { NextRequest, NextResponse } from 'next/server';
import { getGoalDetail } from '@/lib/goals';
import { requireMobileCompany, toJson } from '@/lib/mobile-session';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireMobileCompany(req);
  if ('error' in auth) return auth.error;

  try {
    const { id } = await params;
    const detail = await getGoalDetail(id);
    if (!detail || detail.goal.companyId !== auth.company.id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json(toJson(detail));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load goal';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
