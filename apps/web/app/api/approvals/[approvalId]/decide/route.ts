import { NextRequest, NextResponse } from 'next/server';
import { db, approvals } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { enqueueApprovalWake } from '@/lib/queue';

async function parseDecisionBody(req: NextRequest): Promise<Record<string, string>> {
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const json = (await req.json()) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(json).map(([key, value]) => [key, value == null ? '' : String(value)])
    );
  }

  const formData = await req.formData();
  return Object.fromEntries(
    [...formData.entries()].map(([key, value]) => [
      key,
      typeof value === 'string' ? value : value.name,
    ])
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ approvalId: string }> }
) {
  const { approvalId } = await params;
  // This route is called by human board members from the dashboard.
  // In production, add session-based auth check here.
  const body = await parseDecisionBody(req);

  const decision = body.decision as 'approved' | 'rejected';
  const note = body.note || undefined;

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

  // Enqueue wake for the requesting agent (non-fatal if Redis is unavailable)
  if (approval.requestedByAgentId) {
    try {
      await enqueueApprovalWake({
        approvalId: approvalId,
        agentId: approval.requestedByAgentId,
        companyId: approval.companyId,
        status: decision,
        linkedIssueIds: approval.issueIds,
      });
    } catch (err) {
      console.error('[approval-decide] failed to enqueue approval wake:', err);
    }
  }

  // If dashboard form POST, redirect back
  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('text/html')) {
    return NextResponse.redirect(new URL('/approval', req.url));
  }

  return NextResponse.json(updated);
}
