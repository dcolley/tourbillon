/**
 * Pure helpers for the /approval list toolbar (search + status filter).
 * Mirrors the issue-filter.ts pattern: parse URL params on the server,
 * build hrefs for link-based navigation so the page stays server-rendered.
 */

export const APPROVAL_STATUS_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'awaiting', label: 'Awaiting' },
  { id: 'decided', label: 'Decided' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'pending', label: 'Pending' },
] as const;

export type ApprovalStatusFilter = (typeof APPROVAL_STATUS_FILTERS)[number]['id'];

/** Concrete DB statuses (approvals.status enum): pending | approved | rejected. */
export function parseApprovalStatusFilter(
  value: string | undefined,
): ApprovalStatusFilter {
  if (value && APPROVAL_STATUS_FILTERS.some((f) => f.id === value)) {
    return value as ApprovalStatusFilter;
  }
  return 'all';
}

/**
 * Map a filter to concrete approval statuses for the SQL WHERE clause.
 * awaiting = pending, decided = approved ∪ rejected.
 * 'all' returns null → no status predicate (fetch everything, like today's default).
 */
export function statusesForApprovalFilter(
  filter: ApprovalStatusFilter,
): readonly string[] | null {
  switch (filter) {
    case 'all':
      return null;
    case 'awaiting':
    case 'pending':
      return ['pending'];
    case 'decided':
      return ['approved', 'rejected'];
    case 'approved':
      return ['approved'];
    case 'rejected':
      return ['rejected'];
  }
}

/** Trim + collapse internal whitespace; '' when blank. */
export function normalizeApprovalSearchQuery(value: string | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * True when the status filter selects only pending approvals —
 * used to hide the Recent Decisions section (and vice-versa for 'decided').
 */
export function approvalSectionsForFilter(filter: ApprovalStatusFilter): {
  awaiting: boolean;
  decided: boolean;
} {
  switch (filter) {
    case 'awaiting':
    case 'pending':
      return { awaiting: true, decided: false };
    case 'decided':
    case 'approved':
    case 'rejected':
      return { awaiting: false, decided: true };
    case 'all':
      return { awaiting: true, decided: true };
  }
}

export function approvalListHref(
  filter: ApprovalStatusFilter,
  query: string = '',
): string {
  const params = new URLSearchParams();
  // Always include status (even 'all') so an explicit choice survives reload,
  // same convention as issueListHref.
  params.set('status', filter);
  if (query) params.set('q', query);
  return `/approval?${params.toString()}`;
}
