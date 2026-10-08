import { notFound } from 'next/navigation';
import { getActiveCompanyOrNull } from '@/lib/company';
import { isValidApprovalId, loadApprovalDetail } from '@/lib/approval-detail';
import { createApprovalDetailRepo } from '@/lib/approval-detail-repo';
import { ApprovalDetailView } from '../approval-detail-view';

/**
 * Approval details (board only: the #105 proxy gates every dashboard page on the board session,
 * and the lookup is scoped to the active company, so another company's id is a 404).
 */
export default async function ApprovalDetailPage({ params }: { params: Promise<{ approvalId: string }> }) {
  const company = await getActiveCompanyOrNull();
  if (!company) return null;
  const { approvalId } = await params;
  // Malformed ids (NUL/control characters, >128 chars) never reach the database.
  if (!isValidApprovalId(approvalId)) notFound();
  const detail = await loadApprovalDetail(createApprovalDetailRepo(), company.id, approvalId);
  if (!detail) notFound();
  return <ApprovalDetailView detail={detail} />;
}
