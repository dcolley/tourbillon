import { NextRequest, NextResponse } from 'next/server';
import { db, approvals, type IssueStatus } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { addIssueComment } from '@/lib/issue-comments';
import { formatApprovalDecisionComment } from '@/lib/approval-restore';
import { restoreLinkedIssuesForDecision, wakeAgentsForDecision } from '@/lib/approval-restore-db';
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

  const decided = tourbillonStatus;
  const actor = { actorId: 'hitly', actorName: 'HITLy' };

  const { outcomes } = await db.transaction(async (tx) => {
    await tx
      .update(approvals)
      .set({
        status: decided,
        note,
        decidedAt: new Date(),
        decidedByUserId: 'hitly',
        updatedAt: new Date(),
      })
      .where(eq(approvals.id, approvalId))
      .returning();

    const restored = await restoreLinkedIssuesForDecision(tx, {
      companyId: approval.companyId,
      approvalId,
      decision: decided,
      priorStatuses,
      issueIds,
      note,
      activityActor: actor,
    });

    return { outcomes: restored };
  });

  const title = typeof payload.title === 'string' ? payload.title : approval.type;
  for (const issueId of issueIds) {
    try {
      await addIssueComment(
        issueId,
        approval.companyId,
        { type: 'user', id: 'hitly', name: 'HITLy' },
        formatApprovalDecisionComment({
          source: 'HITLy',
          decision: decided,
          title,
          note,
          outcome: outcomes.find((o) => o.issueId === issueId),
        }),
      );
    } catch (err) {
      console.error('[hitly-resume] failed to comment on issue', issueId, err);
    }
  }

  // Wake the requester and the assignees of unblocked issues (non-fatal if the scheduler is down).
  await wakeAgentsForDecision({
    companyId: approval.companyId,
    approvalId,
    decision: decided,
    note,
    issueIds,
    requesterAgentId: approval.requestedByAgentId,
    outcomes,
    actor,
    logPrefix: '[hitly-resume]',
  });

  return NextResponse.json({ status: 'ok', decision: tourbillonStatus });
}
