import { NextRequest, NextResponse } from 'next/server';
import { db, approvals } from '@tourbillon/db';
import { and, eq } from 'drizzle-orm';
import { applyApprovalDecision } from '@/lib/approval-decide';
import { publicOriginFromRequest } from '@tourbillon/shared';
import { requireBoardCompany } from '@/lib/board-route-auth';

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
  // #106: board only (dashboard session or board JWT). Agents can never decide approvals,
  // including their own; another company's approval is 404.
  const auth = await requireBoardCompany(req);
  if (!auth.ok) return auth.response;
  const company = auth.value;
  const body = await parseDecisionBody(req);

  const decision = body.decision as 'approved' | 'rejected';
  const note = body.note || undefined;

  if (!['approved', 'rejected'].includes(decision)) {
    return NextResponse.json({ error: 'decision must be approved or rejected' }, { status: 400 });
  }

  const approval = await db.query.approvals.findFirst({
    where: and(eq(approvals.id, approvalId), eq(approvals.companyId, company.id)),
  });

  if (!approval) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (approval.status !== 'pending') return NextResponse.json({ error: 'Already decided' }, { status: 409 });

  // Claimed with a conditional update: only one concurrent decision applies its side effects.
  const result = await applyApprovalDecision({
    companyId: approval.companyId,
    approvalId,
    decision,
    note,
    actor: { actorId: 'board', actorName: 'Board' },
    commentAuthor: { type: 'user', id: 'board', name: 'Board' },
    source: 'Board',
    logPrefix: '[approval-decide]',
  });
  if (!result.applied) return NextResponse.json({ error: 'Already decided' }, { status: 409 });

  // If dashboard form POST, redirect back
  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('text/html')) {
    // Build absolute URL using public origin from request headers (never 0.0.0.0)
    return NextResponse.redirect(new URL('/approval', publicOriginFromRequest(req)), 303);
  }

  return NextResponse.json(result.approval);
}
