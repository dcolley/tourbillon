import { NextRequest, NextResponse } from 'next/server';
import { requireBoardCompany } from '@/lib/board-route-auth';
import { approvalDetailJson, isValidApprovalId, loadApprovalDetail } from '@/lib/approval-detail';
import { createApprovalDetailRepo } from '@/lib/approval-detail-repo';

/**
 * Approval details for the board (same data as the `/approval/[approvalId]` page).
 * Board only: agent run/chat bearer → 403, no board session/JWT → 401. Scoped to the board's
 * company: an unknown id and another company's id are both 404. A malformed id (empty, >128
 * chars, control characters such as NUL) is 400. Every field is redacted (lib/approval-redaction).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ approvalId: string }> }) {
  const auth = await requireBoardCompany(req);
  if (!auth.ok) return auth.response;
  const { approvalId } = await params;
  if (!isValidApprovalId(approvalId)) return NextResponse.json({ error: 'Invalid approval id' }, { status: 400 });
  try {
    const detail = await loadApprovalDetail(createApprovalDetailRepo(), auth.value.id, approvalId);
    if (!detail) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(approvalDetailJson(detail));
  } catch (err) {
    console.error('[GET /api/approvals/:id] failed', err instanceof Error ? err.name : typeof err);
    return NextResponse.json({ error: 'Failed to load approval' }, { status: 500 });
  }
}
