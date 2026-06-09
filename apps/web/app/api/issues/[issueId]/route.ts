import { NextRequest, NextResponse } from 'next/server';
import { db, issues, activityLog } from '@paperclip-mastra/db';
import { eq } from 'drizzle-orm';
import { validateRunToken } from '@/lib/auth/run-token';
import { enqueueHeartbeat } from '@/lib/queue';

export async function PATCH(
  req: NextRequest,
  { params }: { params: { issueId: string } }
) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const runCtx = validateRunToken(token);
  if (!runCtx) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

  const runId = req.headers.get('x-paperclip-run-id');
  const body = await req.json() as {
    status?: string;
    comment?: string;
    priority?: string;
    assigneeAgentId?: string;
    blockedByIssueIds?: string[];
  };

  const issue = await db.query.issues.findFirst({ where: eq(issues.id, params.issueId) });
  if (!issue) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (issue.companyId !== runCtx.companyId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.status) updates.status = body.status;
  if (body.priority) updates.priority = body.priority;
  if (body.assigneeAgentId !== undefined) updates.assigneeAgentId = body.assigneeAgentId;
  if (body.blockedByIssueIds !== undefined) updates.blockedByIssueIds = body.blockedByIssueIds;
  if (body.status === 'done') updates.completedAt = new Date();

  // Release checkout lock when terminal status set
  if (['done', 'cancelled', 'blocked', 'in_review'].includes(body.status ?? '')) {
    updates.checkoutRunId = null;
    updates.executionLockedAt = null;
    updates.executionAgentNameKey = null;
  }

  const [updated] = await db.update(issues).set(updates).where(eq(issues.id, params.issueId)).returning();

  await db.insert(activityLog).values({
    companyId: runCtx.companyId,
    actorType: 'agent',
    actorId: runCtx.agentId,
    action: 'issue.updated',
    entityType: 'issue',
    entityId: params.issueId,
    details: { ...updates, comment: body.comment, runId },
  });

  // If status changed to in_review and has a new assignee, wake them
  if (body.status === 'in_review' && body.assigneeAgentId && body.assigneeAgentId !== runCtx.agentId) {
    await enqueueHeartbeat({
      agentId: body.assigneeAgentId,
      companyId: runCtx.companyId,
      invocationSource: 'assignment',
      wakeReason: 'assignment',
      taskId: params.issueId,
    });
  }

  return NextResponse.json(updated);
}
