import { NextRequest, NextResponse } from 'next/server';
import { db, issues, activityLog } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { validateRunToken } from '@/lib/auth/run-token';
import { logAgentApiRequest, logAgentApiResponse, summarizeBody } from '@/lib/agent-api-trace';
import { enqueueHeartbeat } from '@/lib/queue';
import { statusesThatReleaseCheckoutLock, CHECKOUT_LOCK_CLEAR_FIELDS } from '@/lib/checkout-lock';
import { resolveReviewAssignee } from '@/lib/review-routing';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ issueId: string }> }
) {
  const { issueId } = await params;
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

  logAgentApiRequest(`/api/issues/${issueId}`, 'PATCH', runCtx, {
    issueId: issueId,
    headerRunId: runId,
    body: summarizeBody(body),
  });

  const issue = await db.query.issues.findFirst({ where: eq(issues.id, issueId) });
  if (!issue) {
    logAgentApiResponse(`/api/issues/${issueId}`, 'PATCH', runCtx, 404, { issueId: issueId });
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (issue.companyId !== runCtx.companyId) {
    logAgentApiResponse(`/api/issues/${issueId}`, 'PATCH', runCtx, 403, { issueId: issueId });
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let effectiveAssigneeId = body.assigneeAgentId;
  let reviewAssigneeAutoResolved = false;
  let reviewAssigneeReason: string | undefined;

  if (body.status === 'in_review') {
    const needsAutoResolve =
      body.assigneeAgentId === undefined || body.assigneeAgentId === runCtx.agentId;
    if (needsAutoResolve) {
      const resolved = await resolveReviewAssignee(issue, runCtx.agentId);
      if (resolved) {
        effectiveAssigneeId = resolved.agentId;
        reviewAssigneeAutoResolved = true;
        reviewAssigneeReason = resolved.reason;
      }
    }
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.status) updates.status = body.status;
  if (body.priority) updates.priority = body.priority;
  if (effectiveAssigneeId !== undefined) updates.assigneeAgentId = effectiveAssigneeId;
  if (body.blockedByIssueIds !== undefined) updates.blockedByIssueIds = body.blockedByIssueIds;
  if (body.status === 'done') updates.completedAt = new Date();

  // Release checkout lock when leaving active work
  if (body.status && statusesThatReleaseCheckoutLock(body.status)) {
    Object.assign(updates, CHECKOUT_LOCK_CLEAR_FIELDS);
  }

  const [updated] = await db.update(issues).set(updates).where(eq(issues.id, issueId)).returning();

  const activityDetails: Record<string, unknown> = {
    ...updates,
    comment: body.comment,
    runId,
  };
  if (reviewAssigneeAutoResolved) {
    activityDetails.reviewAssigneeAutoResolved = true;
    activityDetails.reviewAssigneeReason = reviewAssigneeReason;
  }

  await db.insert(activityLog).values({
    companyId: runCtx.companyId,
    actorType: 'agent',
    actorId: runCtx.agentId,
    action: 'issue.updated',
    entityType: 'issue',
    entityId: issueId,
    details: activityDetails,
  });

  const assigneeChanged =
    effectiveAssigneeId !== undefined &&
    effectiveAssigneeId !== issue.assigneeAgentId &&
    effectiveAssigneeId !== runCtx.agentId;

  if (assigneeChanged && effectiveAssigneeId) {
    await enqueueHeartbeat({
      agentId: effectiveAssigneeId,
      companyId: runCtx.companyId,
      invocationSource: 'assignment',
      wakeReason: 'assignment',
      taskId: issueId,
    });
  }

  logAgentApiResponse(`/api/issues/${issueId}`, 'PATCH', runCtx, 200, {
    issueId: issueId,
    identifier: updated.identifier,
    status: updated.status,
    priority: updated.priority,
    assigneeAgentId: updated.assigneeAgentId,
    updates,
    reviewAssigneeAutoResolved,
    reviewAssigneeReason,
  });

  return NextResponse.json(updated);
}
