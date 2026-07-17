export const ISSUE_FILTERS = [
  { id: 'active', label: 'Active' },
  { id: 'mine', label: 'Mine' },
  { id: 'in_review', label: 'In review' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'completed', label: 'Completed' },
  { id: 'all', label: 'All' },
  { id: 'backlog', label: 'Backlog' },
  { id: 'cancelled', label: 'Cancelled' },
] as const;

export type IssueFilter = (typeof ISSUE_FILTERS)[number]['id'];

export const ACTIVE_STATUSES = ['todo', 'in_progress', 'in_review', 'blocked'] as const;
export const ALL_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'blocked',
  'cancelled',
] as const;

export function parseIssueFilter(value: string | undefined): IssueFilter {
  if (value && ISSUE_FILTERS.some((f) => f.id === value)) {
    return value as IssueFilter;
  }
  return 'active';
}

export function statusesForFilter(filter: IssueFilter): readonly string[] {
  switch (filter) {
    case 'active':
      return ACTIVE_STATUSES;
    case 'mine':
      return ACTIVE_STATUSES;
    case 'in_review':
      return ['in_review'];
    case 'blocked':
      return ['blocked'];
    case 'completed':
      return ['done'];
    case 'all':
      return ALL_STATUSES;
    case 'backlog':
      return ['backlog'];
    case 'cancelled':
      return ['cancelled'];
  }
}

export function issueListHref(filter: IssueFilter, page = 0): string {
  const params = new URLSearchParams();
  // Always include filter so Active is distinguishable from "no preference" on restore.
  params.set('filter', filter);
  if (page > 0) params.set('page', String(page));
  const qs = params.toString();
  return `/issue?${qs}`;
}

export function parseIssuePage(value: string | undefined): number {
  const n = parseInt(value ?? '0', 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
