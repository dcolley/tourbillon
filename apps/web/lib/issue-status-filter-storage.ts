import {
  ISSUE_FILTERS,
  type IssueFilter,
  parseIssueFilter,
} from '@/app/(dashboard)/issue/issue-filter';

export const ISSUE_STATUS_FILTER_STORAGE_KEY = 'tourbillon:issue-status-filter';

const DEFAULT_FILTER: IssueFilter = 'active';

export function isIssueStatusFilter(value: string): value is IssueFilter {
  return ISSUE_FILTERS.some((f) => f.id === value);
}

export function readIssueStatusFilter(): IssueFilter {
  if (typeof window === 'undefined') return DEFAULT_FILTER;
  try {
    const raw = localStorage.getItem(ISSUE_STATUS_FILTER_STORAGE_KEY);
    if (!raw) return DEFAULT_FILTER;
    const parsed = JSON.parse(raw) as { filter?: string } | string;
    const value = typeof parsed === 'string' ? parsed : parsed.filter;
    return value && isIssueStatusFilter(value) ? value : DEFAULT_FILTER;
  } catch {
    return DEFAULT_FILTER;
  }
}

export function writeIssueStatusFilter(filter: IssueFilter): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(
    ISSUE_STATUS_FILTER_STORAGE_KEY,
    JSON.stringify({ filter: parseIssueFilter(filter) }),
  );
}
