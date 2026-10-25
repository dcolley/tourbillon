/**
 * WID-2: the approval card in the assistant chat. Board only (dashboard session or board JWT; an
 * agent token is refused), active company only: another company's approval is 404.
 *
 * Returns the card view (lib/approval-card): question, options, recommended, default, required
 * reasons, risk, deadline, items by label, status and a non-secret response summary. Never the raw
 * payload, a link URL or a token. Answers go to POST /api/approvals/:id/decide, like /approval.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireBoardCompany } from '@/lib/board-route-auth';
import { expireApprovalIfDue } from '@/lib/approval-expiry';
import { loadApprovalCard } from '@/lib/approval-card';

/** Browser prefetches are not a reviewer seeing the card. */
function isPrefetch(req: NextRequest): boolean {
  const purpose = `${req.headers.get('sec-purpose') ?? ''} ${req.headers.get('purpose') ?? ''}`.toLowerCase();
  return purpose.includes('prefetch');
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ approvalId: string }> }) {
  const { approvalId } = await params;
  const auth = await requireBoardCompany(req);
  if (!auth.ok) return auth.response;
  const company = auth.value;

  // Same lazy expiry as the decide route and the approval pages.
  await expireApprovalIfDue(company.id, approvalId);
  const card = await loadApprovalCard(company.id, approvalId, { recordPresented: !isPrefetch(req) });
  if (!card) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(card, { headers: { 'cache-control': 'no-store' } });
}
