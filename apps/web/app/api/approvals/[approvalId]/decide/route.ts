import { NextRequest, NextResponse } from 'next/server';
import { db, approvals } from '@tourbillon/db';
import { and, eq } from 'drizzle-orm';
import { applyApprovalDecision } from '@/lib/approval-decide';
import { publicOriginFromRequest } from '@tourbillon/shared';
import { requireBoardCompany } from '@/lib/board-route-auth';
import { expireApprovalIfDue } from '@/lib/approval-expiry';
import { formValueFor, resolveDecision, type DecisionSubmission } from '@/lib/approval-answer';
import { BOARD_DECIDER, answerTypeOf, loadHitlEvents, openedRefsOf } from '@/lib/hitl-host';
import { approvalForApi } from '@/lib/approval-api';

/** JSON keeps value types (numbers, arrays); a form keeps every `value` field (multi answers). */
async function parseDecisionBody(req: NextRequest, answerType: string): Promise<DecisionSubmission & { returnTo?: string }> {
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const json = (await req.json()) as Record<string, unknown>;
    return json && typeof json === 'object' ? json : {};
  }

  const formData = await req.formData();
  const text = (key: string) => {
    const v = formData.get(key);
    return typeof v === 'string' ? v : undefined;
  };
  const values = formData.getAll('value').filter((v): v is string => typeof v === 'string');
  return {
    decision: text('decision'),
    status: text('status'),
    value: values.length > 0 ? formValueFor(answerType, values) : undefined,
    reason: text('reason'),
    note: text('note'),
    returnTo: text('returnTo'),
  };
}

/** Only back to the approvals list or one approval page; never an outside URL. */
function safeReturnPath(returnTo: string | undefined, approvalId: string): string {
  if (returnTo === `/approval/${approvalId}`) return returnTo;
  return '/approval';
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

  // APR-2: a past-deadline approval is expired first; deciding it then gets 409.
  await expireApprovalIfDue(company.id, approvalId);

  const approval = await db.query.approvals.findFirst({
    where: and(eq(approvals.id, approvalId), eq(approvals.companyId, company.id)),
  });

  if (!approval) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const body = await parseDecisionBody(req, answerTypeOf(approval));
  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');
  // Dashboard form: back to the page with a short message instead of a JSON error.
  const backWithError = (message: string) => {
    const url = new URL(safeReturnPath(body.returnTo, approvalId), publicOriginFromRequest(req));
    url.searchParams.set('decideError', message);
    url.searchParams.set('for', approvalId);
    return NextResponse.redirect(url, 303);
  };
  if (approval.status !== 'pending') {
    const error = approval.status === 'expired' ? 'Expired' : 'Already decided';
    if (wantsHtml) return backWithError(error === 'Expired' ? 'This request expired before a decision.' : 'This approval was already decided.');
    return NextResponse.json(error === 'Expired' ? { error, status: 'expired' } : { error }, { status: 409 });
  }

  const events = approval.hitlRequest ? await loadHitlEvents(db, company.id, approvalId) : [];
  const resolved = resolveDecision(approval, body, { openedRefs: openedRefsOf(events) });
  if (!resolved.ok) {
    if (wantsHtml) {
      return backWithError(resolved.fields?.map((f) => f.message).join('; ') || resolved.error);
    }
    return NextResponse.json(
      { error: resolved.error, ...(resolved.fields ? { fields: resolved.fields } : {}) },
      { status: resolved.status },
    );
  }

  // Claimed with a conditional update: only one concurrent decision applies its side effects.
  const result = await applyApprovalDecision({
    companyId: approval.companyId,
    approvalId,
    outcome: resolved.outcome,
    note: resolved.note,
    hitl: { value: resolved.value, reason: resolved.reason, decidedBy: BOARD_DECIDER },
    // ACT-1 / #132: record who decided, like the HITLy ('hitly') and MCP ('mcp') paths do.
    decidedByUserId: 'board',
    actor: { actorId: 'board', actorName: 'Board', actorType: 'user' },
    commentAuthor: { type: 'user', id: 'board', name: 'Board' },
    source: 'Board',
    logPrefix: '[approval-decide]',
  });
  if (!result.applied) {
    const expired = await expireApprovalIfDue(company.id, approvalId);
    if (wantsHtml) return backWithError(expired ? 'This request expired before a decision.' : 'This approval was already decided.');
    return NextResponse.json({ error: expired ? 'Expired' : 'Already decided' }, { status: 409 });
  }

  // If dashboard form POST, redirect back
  if (wantsHtml) {
    // Build absolute URL using public origin from request headers (never 0.0.0.0)
    return NextResponse.redirect(new URL(safeReturnPath(body.returnTo, approvalId), publicOriginFromRequest(req)), 303);
  }

  return NextResponse.json(approvalForApi(result.approval));
}
