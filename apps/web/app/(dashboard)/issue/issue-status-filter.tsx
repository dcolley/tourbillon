import Link from 'next/link';
import { Button } from '@/components/ui/button';

export const ISSUE_FILTERS = [
  { id: 'active', label: 'Active' },
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
  if (filter !== 'active') params.set('filter', filter);
  if (page > 0) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `/issue?${qs}` : '/issue';
}

export function parseIssuePage(value: string | undefined): number {
  const n = parseInt(value ?? '0', 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function IssueStatusFilter({ current }: { current: IssueFilter }) {
  return (
    <div className="flex flex-wrap gap-2">
      {ISSUE_FILTERS.map((filter) => (
        <Button
          key={filter.id}
          variant={current === filter.id ? 'default' : 'outline'}
          size="sm"
          render={<Link href={issueListHref(filter.id)} />}
        >
          {filter.label}
        </Button>
      ))}
    </div>
  );
}
