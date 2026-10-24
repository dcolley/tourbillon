import { NextRequest, NextResponse } from 'next/server';
import { db, approvals, type IssueStatus } from '@tourbillon/db';
import { and, eq } from 'drizzle-orm';
import { addIssueComment } from '@/lib/issue-comments';
import { formatApprovalDecisionComment } from '@/lib/approval-restore';
import { restoreLinkedIssuesForDecision, wakeAgentsForDecision } from '@/lib/approval-restore-db';
import { publicOriginFromRequest } from '@tourbillon/shared';
import { requireBoardCompany } from '@/lib/board-route-auth';

type ApprovalPayload = Record<string, unknown> & {
  title?: string;
  summary?: string;
  priorStatuses?: Record<string, IssueStatus>;
};

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

  const payload = (approval.payload ?? {}) as ApprovalPayload;
  const priorStatuses = payload.priorStatuses ?? {};
  const issueIds = approval.issueIds ?? [];

  const actor = { actorId: 'board', actorName: 'Board' };

  const { updated, outcomes } = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(approvals)
      .set({ status: decision, note, decidedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(approvals.id, approvalId), eq(approvals.companyId, company.id)))
      .returning();

    const restored = await restoreLinkedIssuesForDecision(tx, {
      companyId: approval.companyId,
      approvalId,
      decision,
      priorStatuses,
      issueIds,
      note,
      activityActor: actor,
    });

    return { updated: row, outcomes: restored };
  });

  const title = typeof payload.title === 'string' ? payload.title : approval.type;
  for (const issueId of issueIds) {
    try {
      await addIssueComment(
        issueId,
        approval.companyId,
        { type: 'user', id: 'board', name: 'Board' },
        formatApprovalDecisionComment({
          source: 'Board',
          decision,
          title,
          note,
          outcome: outcomes.find((o) => o.issueId === issueId),
        }),
      );
    } catch (err) {
      console.error('[approval-decide] failed to comment on issue', issueId, err);
    }
  }

  // Wake the requester and the assignees of unblocked issues (non-fatal if the scheduler is down).
  await wakeAgentsForDecision({
    companyId: approval.companyId,
    approvalId,
    decision,
    note,
    issueIds,
    requesterAgentId: approval.requestedByAgentId,
    outcomes,
    actor,
    logPrefix: '[approval-decide]',
  });

  // If dashboard form POST, redirect back
  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('text/html')) {
    // Build absolute URL using public origin from request headers (never 0.0.0.0)
    return NextResponse.redirect(new URL('/approval', publicOriginFromRequest(req)), 303);
  }

  return NextResponse.json(updated);
}
