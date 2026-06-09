import { db, activityLog, agents, type ActivityLogEntry } from '@tourbillon/db';
import { and, asc, desc, eq, gt, or } from 'drizzle-orm';

export interface IssueComment {
  id: string;
  body: string;
  authorType: 'user' | 'agent' | 'system';
  authorName: string;
  createdAt: string;
  action: string;
}

function formatActivityBody(entry: ActivityLogEntry): string | null {
  const details = (entry.details ?? {}) as Record<string, unknown>;

  if (typeof details.comment === 'string' && details.comment.trim()) {
    return details.comment.trim();
  }
  if (typeof details.body === 'string' && details.body.trim()) {
    return details.body.trim();
  }

  switch (entry.action) {
    case 'issue.checked_out':
      return '⏳ Checked out issue.';
    case 'issue.created': {
      const createdBy =
        (typeof details.createdBy === 'string' && details.createdBy) ||
        entry.actorName ||
        entry.actorId;
      return `Issue created by ${createdBy}.`;
    }
    case 'issue.commented':
      return null;
    case 'issue.updated': {
      const parts: string[] = [];
      if (typeof details.status === 'string') parts.push(`Status → ${details.status}`);
      if (typeof details.priority === 'string') parts.push(`Priority → ${details.priority}`);
      if (details.assigneeAgentId !== undefined) parts.push('Assignee updated');
      if (Array.isArray(details.blockedByIssueIds)) parts.push('Blockers updated');
      return parts.length > 0 ? parts.join('; ') : null;
    }
    default:
      return null;
  }
}

function resolveAuthorType(entry: ActivityLogEntry): IssueComment['authorType'] {
  if (entry.actorType === 'agent') return 'agent';
  if (entry.actorType === 'user') return 'user';
  return 'system';
}

async function resolveAuthorName(entry: ActivityLogEntry): Promise<string> {
  if (entry.actorName) return entry.actorName;
  if (entry.actorType === 'agent') {
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, entry.actorId) });
    return agent?.name ?? entry.actorId;
  }
  if (entry.actorType === 'user') return 'User';
  return 'System';
}

async function toIssueComment(entry: ActivityLogEntry): Promise<IssueComment | null> {
  const body = formatActivityBody(entry);
  if (!body) return null;

  return {
    id: entry.id,
    body,
    authorType: resolveAuthorType(entry),
    authorName: await resolveAuthorName(entry),
    createdAt: entry.createdAt.toISOString(),
    action: entry.action,
  };
}

export async function listIssueComments(
  issueId: string,
  companyId: string,
  opts: { after?: string; order?: 'asc' | 'desc' } = {}
): Promise<{ comments: IssueComment[]; latestId: string | null }> {
  const order = opts.order ?? 'asc';

  let afterEntry: ActivityLogEntry | undefined;
  if (opts.after) {
    afterEntry = await db.query.activityLog.findFirst({
      where: and(
        eq(activityLog.id, opts.after),
        eq(activityLog.entityType, 'issue'),
        eq(activityLog.entityId, issueId),
        eq(activityLog.companyId, companyId)
      ),
    });
    if (!afterEntry) {
      return { comments: [], latestId: await getLatestIssueActivityId(issueId, companyId) };
    }
  }

  const conditions = [
    eq(activityLog.entityType, 'issue'),
    eq(activityLog.entityId, issueId),
    eq(activityLog.companyId, companyId),
  ];

  if (afterEntry) {
    conditions.push(
      or(
        gt(activityLog.createdAt, afterEntry.createdAt),
        and(
          eq(activityLog.createdAt, afterEntry.createdAt),
          gt(activityLog.id, afterEntry.id)
        )
      )!
    );
  }

  const entries = await db
    .select()
    .from(activityLog)
    .where(and(...conditions))
    .orderBy(order === 'desc' ? desc(activityLog.createdAt) : asc(activityLog.createdAt));

  const comments: IssueComment[] = [];
  for (const entry of entries) {
    const comment = await toIssueComment(entry);
    if (comment) comments.push(comment);
  }

  return {
    comments,
    latestId: await getLatestIssueActivityId(issueId, companyId),
  };
}

export async function getLatestIssueActivityId(
  issueId: string,
  companyId: string
): Promise<string | null> {
  const [latest] = await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.entityType, 'issue'),
        eq(activityLog.entityId, issueId),
        eq(activityLog.companyId, companyId)
      )
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1);

  return latest?.id ?? null;
}

export async function addIssueComment(
  issueId: string,
  companyId: string,
  actor: { type: 'agent' | 'user'; id: string; name?: string },
  body: string,
  runId?: string
): Promise<IssueComment> {
  const trimmed = body.trim();
  if (!trimmed) throw new Error('Comment body is required');

  const [entry] = await db
    .insert(activityLog)
    .values({
      companyId,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: 'issue.commented',
      entityType: 'issue',
      entityId: issueId,
      details: { body: trimmed, comment: trimmed, runId },
    })
    .returning();

  return {
    id: entry.id,
    body: trimmed,
    authorType: actor.type,
    authorName: actor.name ?? actor.id,
    createdAt: entry.createdAt.toISOString(),
    action: entry.action,
  };
}
