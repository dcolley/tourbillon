import { NextRequest, NextResponse } from 'next/server';
import { db, approvals, issues, activityLog, type IssueStatus } from '@tourbillon/db';
import { and, eq, inArray } from 'drizzle-orm';
import { enqueueApprovalWake } from '@/lib/wake-client';
import { addIssueComment } from '@/lib/issue-comments';
import { publicOriginFromRequest } from '@tourbillon/shared';
import { requireBoardCompany } from '@/lib/board-route-auth';
import { APPROVAL_ACTORS, approvalActivityScrubber, approvalDecidedActivity } from '@/lib/approval-activity';
import { approvalDetailHref } from '@/lib/approval-links';
import { isValidApprovalId } from '@/lib/approval-detail';

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
  // NUL/control characters made Postgres throw (500); malformed ids are a 400.
  if (!isValidApprovalId(approvalId)) return NextResponse.json({ error: 'Invalid approval id' }, { status: 400 });
  const body = await parseDecisionBody(req);

  const decision = body.decision as 'approved' | 'rejected';
  const note = body.note || undefined;

  if (!['approved', 'rejected'].includes(decision)) {
    return NextResponse.json({ error: 'decision must be approved or rejected' }, { status: 400 });
  }
  // A reject is the board's "request changes": the reason is the feedback the requesting agent
  // gets, so it is required (board UI, this board API and MCP decide_approval).
  if (decision === 'rejected' && !note?.trim()) {
    if ((req.headers.get('accept') ?? '').includes('text/html')) {
      const back = new URL(approvalDetailHref(approvalId), publicOriginFromRequest(req));
      back.searchParams.set('error', 'reason_required');
      return NextResponse.redirect(back, 303);
    }
    return NextResponse.json(
      { error: 'A reason is required to reject (it is sent to the requesting agent as Board feedback)' },
      { status: 400 },
    );
  }

  const approval = await db.query.approvals.findFirst({
    where: and(eq(approvals.id, approvalId), eq(approvals.companyId, company.id)),
  });

  if (!approval) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (approval.status !== 'pending') return NextResponse.json({ error: 'Already decided' }, { status: 409 });

  const payload = (approval.payload ?? {}) as ApprovalPayload;
  const priorStatuses = payload.priorStatuses ?? {};
  const issueIds = approval.issueIds ?? [];

  const activityNote = approvalActivityScrubber(approval.payload)(note) ?? undefined;
  const updated = await db.transaction(async (tx) => {
    // Only a still-pending row is decided (a concurrent decide gets 409, and writes no second
    // approval.decided row).
    const [row] = await tx
      .update(approvals)
      .set({ status: decision, note, decidedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(approvals.id, approvalId), eq(approvals.companyId, company.id), eq(approvals.status, 'pending')),
      )
      .returning();
    if (!row) return null;

    await tx
      .insert(activityLog)
      .values(approvalDecidedActivity({ approval, decision, note, actor: APPROVAL_ACTORS.board }));

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
          decision === 'approved'
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
          actorId: 'board',
          actorName: 'Board',
          action: 'issue.updated',
          entityType: 'issue',
          entityId: issue.id,
          details: {
            status: restoreStatus,
            boardApprovalId: null,
            approvalId,
            decision,
            // Scrubbed like the approval.decided row (no resume token or secret stored).
            note: activityNote,
          },
        });
      }
    }

    return row;
  });
  if (!updated) return NextResponse.json({ error: 'Already decided' }, { status: 409 });

  const decisionLabel = decision === 'approved' ? 'Approved' : 'Rejected';
  const title = typeof payload.title === 'string' ? payload.title : approval.type;
  const commentBody = [
    `**Board ${decisionLabel}:** ${title}`,
    note ? `Note: ${note}` : null,
    decision === 'approved'
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
        { type: 'user', id: 'board', name: 'Board' },
        commentBody,
      );
    } catch (err) {
      console.error('[approval-decide] failed to comment on issue', issueId, err);
    }
  }

  // Trigger WakeRunner for the requesting agent (non-fatal if scheduler is down)
  if (approval.requestedByAgentId) {
    try {
      await enqueueApprovalWake({
        approvalId: approvalId,
        agentId: approval.requestedByAgentId,
        companyId: approval.companyId,
        status: decision,
        note,
        linkedIssueIds: approval.issueIds,
      });
    } catch (err) {
      console.error('[approval-decide] failed to trigger approval wake:', err);
    }
  }

  // If dashboard form POST, redirect back
  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('text/html')) {
    // Build absolute URL using public origin from request headers (never 0.0.0.0)
    return NextResponse.redirect(new URL('/approval', publicOriginFromRequest(req)), 303);
  }

  return NextResponse.json(updated);
}
