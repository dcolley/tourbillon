import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { stickyPageToolbarClass } from '@/lib/sticky-toolbar';

export function IssuePageToolbar({
  title,
  statusFilter,
  actions,
}: {
  title: string;
  statusFilter: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className={cn(stickyPageToolbarClass, 'mb-4')}>
      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
        </div>
        {statusFilter}
      </div>
    </div>
  );
}
