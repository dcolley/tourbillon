'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { LayoutGrid, List } from 'lucide-react';
import { Button } from '@/components/ui/button';

const STORAGE_KEY = 'tourbillon:issue-view';

export type IssueViewMode = 'list' | 'kanban';

export function IssueViewControls({
  listView,
  kanbanView,
  toolbarActions,
}: {
  listView: ReactNode;
  kanbanView: ReactNode;
  toolbarActions?: ReactNode;
}) {
  const [view, setView] = useState<IssueViewMode | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    setView(stored === 'list' || stored === 'kanban' ? stored : 'kanban');
  }, []);

  function selectView(next: IssueViewMode) {
    setView(next);
    localStorage.setItem(STORAGE_KEY, next);
  }

  if (view === null) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {toolbarActions}
          <Button variant="outline" size="sm" disabled>
            <List className="size-4" />
            List
          </Button>
          <Button variant="default" size="sm" disabled>
            <LayoutGrid className="size-4" />
            Kanban
          </Button>
        </div>
        {kanbanView}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {toolbarActions}
        <Button
          variant={view === 'list' ? 'default' : 'outline'}
          size="sm"
          onClick={() => selectView('list')}
        >
          <List className="size-4" />
          List
        </Button>
        <Button
          variant={view === 'kanban' ? 'default' : 'outline'}
          size="sm"
          onClick={() => selectView('kanban')}
        >
          <LayoutGrid className="size-4" />
          Kanban
        </Button>
      </div>
      {view === 'list' ? listView : kanbanView}
    </div>
  );
}
