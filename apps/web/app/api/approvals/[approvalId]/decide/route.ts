import { NextRequest, NextResponse } from 'next/server';
import { db, approvals } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { enqueueApprovalWake } from '@/lib/queue';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ approvalId: string }> }
) {
  const { approvalId } = await params;
  // This route is called by human board members from the dashboard.
  // In production, add session-based auth check here.
  const body = await req.json().catch(() => null) ||
    Object.fromEntries((await req.formData()).entries());

  const decision = body.decision as 'approved' | 'rejected';
  const note = body.note as string | undefined;

  if (!['approved', 'rejected'].includes(decision)) {
    return NextResponse.json({ error: 'decision must be approved or rejected' }, { status: 400 });
  }

  const approval = await db.query.approvals.findFirst({
    where: eq(approvals.id, approvalId),
  });

  if (!approval) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (approval.status !== 'pending') return NextResponse.json({ error: 'Already decided' }, { status: 409 });

  const [updated] = await db
    .update(approvals)
    .set({ status: decision, note, decidedAt: new Date(), updatedAt: new Date() })
    .where(eq(approvals.id, approvalId))
    .returning();

  // Enqueue wake for the requesting agent
  if (approval.requestedByAgentId) {
    await enqueueApprovalWake({
      approvalId: approvalId,
      agentId: approval.requestedByAgentId,
      companyId: approval.companyId,
      status: decision,
      linkedIssueIds: approval.issueIds,
    });
  }

  // If dashboard form POST, redirect back
  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('text/html')) {
    return NextResponse.redirect(new URL('/approval', req.url));
  }

  return NextResponse.json(updated);
}
