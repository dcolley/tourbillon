'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ISSUE_FILTERS, issueListHref, type IssueFilter } from './issue-filter';

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
