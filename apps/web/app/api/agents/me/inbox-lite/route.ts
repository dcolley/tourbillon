import { NextRequest, NextResponse } from 'next/server';
import { db, issues, agents, type IssueStatus } from '@tourbillon/db';
import { eq, and, inArray, isNull } from 'drizzle-orm';
import { validateRunToken } from '@/lib/auth/run-token';
import { logAgentApiRequest, logAgentApiResponse } from '@/lib/agent-api-trace';
import { sortInboxIssues } from '@tourbillon/shared/inbox-sort';

export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const runCtx = validateRunToken(token);
  if (!runCtx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  logAgentApiRequest('/api/agents/me/inbox-lite', 'GET', runCtx);

  const workableStatuses: IssueStatus[] = ['in_progress', 'in_review', 'todo', 'blocked'];

  const [callingAgent, myIssues] = await Promise.all([
    db.query.agents.findFirst({
      where: eq(agents.id, runCtx.agentId),
      columns: { role: true },
    }),
    db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, runCtx.companyId),
          eq(issues.assigneeAgentId, runCtx.agentId),
          inArray(issues.status, workableStatuses),
        ),
      ),
  ]);

  if (callingAgent?.role === 'ceo') {
    const orphanedInReview = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, runCtx.companyId),
          eq(issues.status, 'in_review'),
          isNull(issues.assigneeAgentId),
        ),
      );

    const seen = new Set(myIssues.map((i) => i.id));
    for (const issue of orphanedInReview) {
      if (!seen.has(issue.id)) {
        myIssues.push(issue);
        seen.add(issue.id);
      }
    }
  }

  const sortedIssues = sortInboxIssues(myIssues);

  logAgentApiResponse('/api/agents/me/inbox-lite', 'GET', runCtx, 200, {
    issueCount: sortedIssues.length,
    issueIds: sortedIssues.map((i) => i.id),
    identifiers: sortedIssues.map((i) => i.identifier),
  });

  return NextResponse.json({
    issues: sortedIssues.map((i) => ({
      id: i.id,
      identifier: i.identifier,
      title: i.title,
      status: i.status,
      priority: i.priority,
      parentId: i.parentId,
      goalId: i.goalId,
      blockedByIssueIds: i.blockedByIssueIds,
      ...(i.status === 'in_review' && !i.assigneeAgentId
        ? { triageReason: 'unassigned_in_review' as const }
        : {}),
    })),
    total: myIssues.length,
  });
}
