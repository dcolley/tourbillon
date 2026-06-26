import { db, issues, agents } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import type { HeartbeatJobData, WakePayload } from '@tourbillon/shared';
import { listIssueComments } from './issue-comments';

const DEFAULT_MAX_COMMENTS = 10;

export interface BuildAssignmentWakePayloadOptions {
  maxComments?: number;
}

export async function buildAssignmentWakePayload(
  issueId: string,
  companyId: string,
  opts: BuildAssignmentWakePayloadOptions = {}
): Promise<WakePayload | null> {
  const maxComments = opts.maxComments ?? DEFAULT_MAX_COMMENTS;

  const issue = await db.query.issues.findFirst({
    where: eq(issues.id, issueId),
  });
  if (!issue || issue.companyId !== companyId) return null;

  const { comments: allComments } = await listIssueComments(issueId, companyId, { order: 'desc' });
  const recent = allComments.slice(0, maxComments).reverse();

  return {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      assigneeAgentId: issue.assigneeAgentId ?? '',
    },
    newComments: recent.map((c) => ({
      id: c.id,
      body: c.body,
      authorType: c.authorType === 'user' ? 'user' as const : 'agent' as const,
      authorName: c.authorName,
      createdAt: c.createdAt,
    })),
    fallbackFetchNeeded: true,
  };
}

export async function buildAssignmentWakePayloadJson(
  issueId: string,
  companyId: string,
  opts?: BuildAssignmentWakePayloadOptions
): Promise<string | undefined> {
  const payload = await buildAssignmentWakePayload(issueId, companyId, opts);
  return payload ? JSON.stringify(payload) : undefined;
}

export async function enrichHeartbeatJob(data: HeartbeatJobData): Promise<HeartbeatJobData> {
  let enriched = data;

  if (!enriched.agentName) {
    const agent = await db.query.agents.findFirst({
      where: eq(agents.id, data.agentId),
      columns: { name: true },
    });
    if (agent?.name) enriched = { ...enriched, agentName: agent.name };
  }

  if (!enriched.taskId || enriched.wakePayloadJson) return enriched;

  const wakePayloadJson = await buildAssignmentWakePayloadJson(enriched.taskId, enriched.companyId);
  if (!wakePayloadJson) return enriched;

  return { ...enriched, wakePayloadJson };
}
