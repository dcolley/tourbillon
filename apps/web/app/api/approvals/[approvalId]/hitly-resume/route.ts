import { NextRequest, NextResponse } from 'next/server';
import { db, approvals, issues, activityLog, type IssueStatus } from '@tourbillon/db';
import { and, eq, inArray } from 'drizzle-orm';
import { enqueueApprovalWake } from '@/lib/wake-client';
import { addIssueComment } from '@/lib/issue-comments';
import type { HitlyResumePayload } from '@/lib/hitly/client';

type ApprovalPayload = Record<string, unknown> & {
  title?: string;
  summary?: string;
  priorStatuses?: Record<string, IssueStatus>;
  hitlyResumeToken?: string;
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ approvalId: string }> }
) {
  const { approvalId } = await params;

  // This route is called by HITLy via the resumeUrl callback (unsigned POST)
  // Token is in query string, not Authorization header
  const { searchParams } = new URL(req.url);
  const token = searchParams.get('token');

  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 });
  }

  const body = (await req.json()) as HitlyResumePayload;
  const { decision, metadata, id: hitlyId } = body;

  // Load approval
  const approval = await db.query.approvals.findFirst({
    where: eq(approvals.id, approvalId),
  });

  if (!approval) {
    return NextResponse.json({ error: 'Approval not found' }, { status: 404 });
  }

  if (approval.status !== 'pending') {
    // Already decided — idempotent success
    return NextResponse.json({ status: 'ok', alreadyDecided: true });
  }

  // Validate resume token
  const payload = (approval.payload ?? {}) as ApprovalPayload;
  const storedToken = payload.hitlyResumeToken;

  if (!storedToken || storedToken !== token) {
    console.error('[hitly-resume] Invalid or missing resume token', { approvalId, hitlyId });
    return NextResponse.json({ error: 'Invalid resume token' }, { status: 400 });
  }

  // Validate HITLy approval id if provided
  if (hitlyId && approval.hitlyApprovalId && approval.hitlyApprovalId !== hitlyId) {
    console.error('[hitly-resume] HITLy id mismatch', {
      approvalId,
      expected: approval.hitlyApprovalId,
      received: hitlyId,
    });
    return NextResponse.json({ error: 'HITLy id mismatch' }, { status: 400 });
  }

  // Map HITLy decision to Tourbillon status
  let tourbillonStatus: 'approved' | 'rejected' | null = null;
  let note = '';

  if (decision === 'accept') {
    tourbillonStatus = 'approved';
    note = metadata?.note ? String(metadata.note) : 'Approved via HITLy';
  } else if (decision === 'reject') {
    tourbillonStatus = 'rejected';
    note = metadata?.note ? String(metadata.note) : 'Rejected via HITLy';
  } else {
    // Unknown decision — fail closed: stay pending, log error
    const errorMsg = `HITLy returned unsupported decision: ${decision}`;
    console.error('[hitly-resume]', errorMsg, { approvalId, hitlyId, decision });
    
    await db
      .update(approvals)
      .set({
        hitlyError: errorMsg,
        updatedAt: new Date(),
      })
      .where(eq(approvals.id, approvalId));

    return NextResponse.json({ error: errorMsg }, { status: 400 });
  }

  // Apply decision with same side effects as in-app decide
  const priorStatuses = payload.priorStatuses ?? {};
  const issueIds = approval.issueIds ?? [];

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(approvals)
      .set({
        status: tourbillonStatus,
        note,
        decidedAt: new Date(),
        decidedByUserId: 'hitly',
        updatedAt: new Date(),
      })
      .where(eq(approvals.id, approvalId))
      .returning();

    if (issueIds.length > 0) {
      const linked = await tx
        .select({ id: issues.id, status: issues.status, boardApprovalId: issues.boardApprovalId })
        .from(issues)
        .where(and(eq(issues.companyId, approval.companyId), inArray(issues.id, issueIds)));

      const now = new Date();
      for (const issue of linked) {
        // Only clear halt for issues still bound to this approval
        if (issue.boardApprovalId && issue.boardApprovalId !== approvalId) continue;

        const restoreStatus =
          tourbillonStatus === 'approved'
            ? (priorStatuses[issue.id] ?? (issue.status === 'blocked' ? 'todo' : issue.status))
            : 'blocked';

        await tx
          .update(issues)
          .set({
            status: restoreStatus,
            boardApprovalId: null,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id));

        await tx.insert(activityLog).values({
          companyId: approval.companyId,
          actorType: 'system',
          actorId: 'hitly',
          actorName: 'HITLy',
          action: 'issue.updated',
          entityType: 'issue',
          entityId: issue.id,
          details: {
            status: restoreStatus,
            boardApprovalId: null,
            approvalId,
            decision: tourbillonStatus,
            note,
          },
        });
      }
    }

    return row;
  });

  const decisionLabel = tourbillonStatus === 'approved' ? 'Approved' : 'Rejected';
  const title = typeof payload.title === 'string' ? payload.title : approval.type;
  const commentBody = [
    `**HITLy ${decisionLabel}:** ${title}`,
    note ? `Note: ${note}` : null,
    tourbillonStatus === 'approved'
      ? 'Linked issues have been unhalted (status restored). Continue work if still assigned.'
      : 'Linked issues remain blocked. Triage, revise the request, or cancel as appropriate.',
  ]
    .filter(Boolean)
    .join('\n');

  for (const issueId of issueIds) {
    try {
      await addIssueComment(
        issueId,
        approval.companyId,
        { type: 'user', id: 'hitly', name: 'HITLy' },
        commentBody,
      );
    } catch (err) {
      console.error('[hitly-resume] failed to comment on issue', issueId, err);
    }
  }

  // Trigger WakeRunner for the requesting agent (non-fatal if scheduler is down)
  if (approval.requestedByAgentId) {
    try {
      await enqueueApprovalWake({
        approvalId: approvalId,
        agentId: approval.requestedByAgentId,
        companyId: approval.companyId,
        status: tourbillonStatus,
        note,
        linkedIssueIds: approval.issueIds,
      });
    } catch (err) {
      console.error('[hitly-resume] failed to trigger approval wake:', err);
    }
  }

  return NextResponse.json({ status: 'ok', decision: tourbillonStatus });
}
