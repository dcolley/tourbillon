import { NextRequest, NextResponse } from 'next/server';
import { db, issues, goals, projects } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { validateRunToken } from '@/lib/auth/run-token';
import { logAgentApiRequest, logAgentApiResponse } from '@/lib/agent-api-trace';
import { getLatestIssueActivityId } from '@/lib/issue-comments';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ issueId: string }> }
) {
  const { issueId } = await params;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const runCtx = validateRunToken(token);
  if (!runCtx) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

  logAgentApiRequest(`/api/issues/${issueId}/heartbeat-context`, 'GET', runCtx, {
    issueId: issueId,
  });

  const issue = await db.query.issues.findFirst({
    where: eq(issues.id, issueId),
    with: { goal: true, project: true, assigneeAgent: true },
  });

  if (!issue) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (issue.companyId !== runCtx.companyId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const lastSeenCommentId = await getLatestIssueActivityId(issueId, runCtx.companyId);

  // Resolve blocked-by titles for context
  const blockers = issue.blockedByIssueIds?.length
    ? await db.select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
        .from(issues)
        .where(eq(issues.companyId, runCtx.companyId))
    : [];

  logAgentApiResponse(`/api/issues/${issueId}/heartbeat-context`, 'GET', runCtx, 200, {
    issueId: issueId,
    identifier: issue.identifier,
    status: issue.status,
    assigneeAgentId: issue.assigneeAgentId,
  });

  return NextResponse.json({
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      status: issue.status,
      priority: issue.priority,
      parentId: issue.parentId,
    },
    goal: issue.goal
      ? {
          id: issue.goal.id,
          title: issue.goal.title,
          description: issue.goal.description,
          status: issue.goal.status,
        }
      : null,
    project: issue.project ? { id: issue.project.id, title: issue.project.title } : null,
    blockedBy: blockers.filter((b) => issue.blockedByIssueIds.includes(b.id)),
    lastSeenCommentId,
  });
}
