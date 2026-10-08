/**
 * Board 'Archive agent' copy and counts shape (pure: safe in client components).
 */
export interface ArchiveImpact {
  /** Pending approvals the agent requested (rejected by the archive). */
  pendingApprovals: number;
  /** Open issues assigned to the agent (unassigned by the archive). */
  openIssues: number;
}

/** Confirm-dialog line: 'N pending approvals will be rejected, M open issues unassigned'. */
export function archiveImpactText(impact: ArchiveImpact): string {
  const n = impact.pendingApprovals;
  const m = impact.openIssues;
  return `${n} pending ${n === 1 ? 'approval' : 'approvals'} will be rejected, ${m} open ${m === 1 ? 'issue' : 'issues'} unassigned`;
}

/** Archiving is permanent: there is no unarchive. */
export const ARCHIVE_PERMANENT_COPY =
  "This is permanent: an archived agent can't be unarchived or reactivated.";

/** After the archive: 'N pending approvals rejected, M open issues unassigned'. */
export function archiveResultText(done: { approvalsRejected: number; issuesUnassigned: number }): string {
  const n = done.approvalsRejected;
  const m = done.issuesUnassigned;
  return `${n} pending ${n === 1 ? 'approval' : 'approvals'} rejected, ${m} open ${m === 1 ? 'issue' : 'issues'} unassigned`;
}
