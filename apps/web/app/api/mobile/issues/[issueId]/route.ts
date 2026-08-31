import { NextRequest, NextResponse } from 'next/server';
import { getIssueDetail } from '@/lib/issues';
import { requireMobileCompany, toJson } from '@/lib/mobile-session';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ issueId: string }> },
) {
  const auth = await requireMobileCompany(req);
  if ('error' in auth) return auth.error;

  try {
    const { issueId } = await params;
    const detail = await getIssueDetail(issueId);
    if (!detail || detail.issue.companyId !== auth.company.id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({
      issue: toJson(detail.issue),
      assignee: detail.assignee,
      goal: detail.goal,
      project: detail.project,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load issue';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
