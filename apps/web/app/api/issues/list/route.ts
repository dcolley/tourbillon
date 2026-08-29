import { NextRequest, NextResponse } from 'next/server';
import { BOARD_USER_ID } from '@tourbillon/shared';
import { ISSUE_KANBAN_LIMIT, listIssues } from '@/lib/issues';
import { parseIssueFilter, statusesForFilter } from '@/app/(dashboard)/issue/issue-filter';
import { verifyMobileToken } from '@/lib/mobile-auth';

function serializeIssueRow(row: Awaited<ReturnType<typeof listIssues>>['rows'][number]) {
  const { issue, agent } = row;
  return {
    issue: {
      ...issue,
      executionLockedAt: issue.executionLockedAt?.toISOString() ?? null,
      startedAt: issue.startedAt?.toISOString() ?? null,
      completedAt: issue.completedAt?.toISOString() ?? null,
      createdAt: issue.createdAt.toISOString(),
      updatedAt: issue.updatedAt.toISOString(),
    },
    agent,
  };
}

export async function GET(req: NextRequest) {
  try {
    // Support mobile token-based auth
    const mobileCompanyId = await verifyMobileToken(req);
    
    const filter = parseIssueFilter(req.nextUrl.searchParams.get('filter') ?? undefined);
    const visibleStatuses = statusesForFilter(filter);

    const result = await listIssues({
      statuses: visibleStatuses,
      page: 0,
      pageSize: ISSUE_KANBAN_LIMIT,
      assigneeUserId: filter === 'mine' ? BOARD_USER_ID : undefined,
      companyIdOverride: mobileCompanyId || undefined,
    });

    return NextResponse.json({
      filter,
      rows: result.rows.map(serializeIssueRow),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list issues';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
