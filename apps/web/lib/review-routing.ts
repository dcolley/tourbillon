import { db, issues, agents, activityLog, type Issue } from '@tourbillon/db';
import { and, asc, eq } from 'drizzle-orm';

export type ReviewAssigneeReason = 'parent_assignee' | 'creator' | 'reports_to';

export interface ResolvedReviewAssignee {
  agentId: string;
  name: string | null;
  reason: ReviewAssigneeReason;
}

async function loadAgentName(agentId: string): Promise<string | null> {
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
    columns: { name: true },
  });
  return agent?.name ?? null;
}

export async function resolveReviewAssignee(
  issue: Issue,
  submittingAgentId: string,
): Promise<ResolvedReviewAssignee | null> {
  if (issue.parentId) {
    const parent = await db.query.issues.findFirst({
      where: eq(issues.id, issue.parentId),
      columns: { assigneeAgentId: true },
    });
    if (parent?.assigneeAgentId && parent.assigneeAgentId !== submittingAgentId) {
      return {
        agentId: parent.assigneeAgentId,
        name: await loadAgentName(parent.assigneeAgentId),
        reason: 'parent_assignee',
      };
    }
  }

  const [created] = await db
    .select({ actorId: activityLog.actorId })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, issue.companyId),
        eq(activityLog.entityId, issue.id),
        eq(activityLog.entityType, 'issue'),
        eq(activityLog.action, 'issue.created'),
        eq(activityLog.actorType, 'agent'),
      ),
    )
    .orderBy(asc(activityLog.createdAt))
    .limit(1);

  if (created?.actorId && created.actorId !== submittingAgentId) {
    return {
      agentId: created.actorId,
      name: await loadAgentName(created.actorId),
      reason: 'creator',
    };
  }

  const submittingAgent = await db.query.agents.findFirst({
    where: eq(agents.id, submittingAgentId),
    columns: { reportsToId: true },
  });

  if (submittingAgent?.reportsToId && submittingAgent.reportsToId !== submittingAgentId) {
    return {
      agentId: submittingAgent.reportsToId,
      name: await loadAgentName(submittingAgent.reportsToId),
      reason: 'reports_to',
    };
  }

  return null;
}
