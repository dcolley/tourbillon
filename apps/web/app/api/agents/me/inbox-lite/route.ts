import { NextRequest, NextResponse } from 'next/server';
import { db, issues } from '@paperclip-mastra/db';
import { eq, and, inArray } from 'drizzle-orm';
import { validateRunToken } from '@/lib/auth/run-token';
import { ISSUE_STATUS_WORK_PRIORITY } from '@paperclip-mastra/shared';

export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const runCtx = validateRunToken(token);
  if (!runCtx) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

  const workableStatuses = ['in_progress', 'in_review', 'todo', 'blocked'];

  const myIssues = await db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.companyId, runCtx.companyId),
        eq(issues.assigneeAgentId, runCtx.agentId),
        inArray(issues.status, workableStatuses)
      )
    );

  // Sort by status priority, then by issue priority
  const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  myIssues.sort((a, b) => {
    const statusDiff = (ISSUE_STATUS_WORK_PRIORITY[a.status] ?? 99) - (ISSUE_STATUS_WORK_PRIORITY[b.status] ?? 99);
    if (statusDiff !== 0) return statusDiff;
    return (priorityOrder[a.priority] ?? 99) - (priorityOrder[b.priority] ?? 99);
  });

  return NextResponse.json({
    issues: myIssues.map((i) => ({
      id: i.id,
      identifier: i.identifier,
      title: i.title,
      status: i.status,
      priority: i.priority,
      parentId: i.parentId,
      goalId: i.goalId,
      blockedByIssueIds: i.blockedByIssueIds,
    })),
    total: myIssues.length,
  });
}
