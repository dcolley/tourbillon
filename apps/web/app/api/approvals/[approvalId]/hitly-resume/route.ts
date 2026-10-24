import { NextRequest, NextResponse } from 'next/server';
import { db, approvals } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { applyApprovalDecision } from '@/lib/approval-decide';
import type { HitlyResumePayload } from '@/lib/hitly/client';

type ApprovalPayload = Record<string, unknown> & {
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

  // Apply decision with same side effects as in-app decide. Claimed with a conditional update:
  // a concurrent callback or Board decision that got there first wins, and this call is a no-op.
  const result = await applyApprovalDecision({
    companyId: approval.companyId,
    approvalId,
    decision: tourbillonStatus,
    note,
    decidedByUserId: 'hitly',
    actor: { actorId: 'hitly', actorName: 'HITLy' },
    commentAuthor: { type: 'user', id: 'hitly', name: 'HITLy' },
    source: 'HITLy',
    logPrefix: '[hitly-resume]',
  });
  if (!result.applied) {
    // Already decided — idempotent success (same as the check above)
    return NextResponse.json({ status: 'ok', alreadyDecided: true });
  }

  return NextResponse.json({ status: 'ok', decision: tourbillonStatus });
}
