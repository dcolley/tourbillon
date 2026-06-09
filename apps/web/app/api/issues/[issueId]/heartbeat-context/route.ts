import { NextRequest, NextResponse } from 'next/server';
import { db, issues, goals, projects } from '@paperclip-mastra/db';
import { eq } from 'drizzle-orm';
import { validateRunToken } from '@/lib/auth/run-token';

export async function GET(
  req: NextRequest,
  { params }: { params: { issueId: string } }
) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const runCtx = validateRunToken(token);
  if (!runCtx) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

  const issue = await db.query.issues.findFirst({
    where: eq(issues.id, params.issueId),
    with: { goal: true, project: true, assigneeAgent: true },
  });

  if (!issue) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (issue.companyId !== runCtx.companyId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Resolve blocked-by titles for context
  const blockers = issue.blockedByIssueIds?.length
    ? await db.select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
        .from(issues)
        .where(eq(issues.companyId, runCtx.companyId))
    : [];

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
    goal: issue.goal ? { id: issue.goal.id, title: issue.goal.title } : null,
    project: issue.project ? { id: issue.project.id, title: issue.project.title } : null,
    blockedBy: blockers.filter((b) => issue.blockedByIssueIds.includes(b.id)),
  });
}
