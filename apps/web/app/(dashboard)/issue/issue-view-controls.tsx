'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { LayoutGrid, List } from 'lucide-react';
import { Button } from '@/components/ui/button';

const STORAGE_KEY = 'tourbillon:issue-view';

export type IssueViewMode = 'list' | 'kanban';

export function useIssueViewMode(): {
  view: IssueViewMode | null;
  setView: (next: IssueViewMode) => void;
} {
  const [view, setViewState] = useState<IssueViewMode | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    setViewState(stored === 'list' || stored === 'kanban' ? stored : 'kanban');
  }, []);

  function setView(next: IssueViewMode) {
    setViewState(next);
    localStorage.setItem(STORAGE_KEY, next);
  }

  return { view, setView };
}

export function IssueViewToggle({
  view,
  onViewChange,
  disabled,
}: {
  view: IssueViewMode | null;
  onViewChange: (next: IssueViewMode) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <Button
        variant={view === 'list' ? 'default' : 'outline'}
        size="sm"
        disabled={disabled || view === null}
        onClick={() => onViewChange('list')}
      >
        <List className="size-4" />
        List
      </Button>
      <Button
        variant={view === 'kanban' ? 'default' : 'outline'}
        size="sm"
        disabled={disabled || view === null}
        onClick={() => onViewChange('kanban')}
      >
        <LayoutGrid className="size-4" />
        Kanban
      </Button>
    </>
  );
}

export function IssueViewControls({
  view,
  listView,
  kanbanView,
}: {
  view: IssueViewMode | null;
  listView: ReactNode;
  kanbanView: ReactNode;
}) {
  if (view === null) {
    return kanbanView;
  }

  return view === 'list' ? listView : kanbanView;
}
