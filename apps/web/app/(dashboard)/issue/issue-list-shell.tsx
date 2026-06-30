'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ISSUE_KANBAN_LIMIT, type IssueListRow } from '@/lib/issue-list';
import {
  ISSUE_LIST_REFRESH_INTERVALS,
  isIssueListRefreshInterval,
  readIssueListRefreshPrefs,
  writeIssueListRefreshPrefs,
  type IssueListRefreshIntervalSec,
} from '@/lib/issue-list-refresh-storage';
import type { IssueFilter } from './issue-status-filter';
import { IssueBoard } from './issue-board';
import { IssueTable } from './issue-table';
import { IssueViewControls } from './issue-view-controls';

interface AgentOption {
  id: string;
  name: string;
  urlKey: string;
}

interface IssueListResponse {
  filter: IssueFilter;
  rows: IssueListRow[];
  total: number;
  page: number;
  pageSize: number;
}

export function IssueListShell({
  filter,
  visibleStatuses,
  initialIssues,
  initialTotal,
  agents,
  emptyMessage,
}: {
  filter: IssueFilter;
  visibleStatuses: readonly string[];
  initialIssues: IssueListRow[];
  initialTotal: number;
  agents: AgentOption[];
  emptyMessage: string;
}) {
  const [issues, setIssues] = useState(initialIssues);
  const [total, setTotal] = useState(initialTotal);
  const [refreshIntervalSec, setRefreshIntervalSec] = useState<IssueListRefreshIntervalSec | null>(
    null,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRefreshIntervalSec(readIssueListRefreshPrefs().refreshIntervalSec);
  }, []);

  useEffect(() => {
    setIssues(initialIssues);
    setTotal(initialTotal);
    setError(null);
  }, [filter, initialIssues, initialTotal]);

  const fetchIssues = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (opts?.silent) {
        setRefreshing(true);
      }
      setError(null);
      try {
        const params = new URLSearchParams();
        if (filter !== 'active') params.set('filter', filter);

        const res = await fetch(`/api/issues/list?${params}`);
        if (!res.ok) throw new Error(`Failed to load issues (${res.status})`);
        const json = (await res.json()) as IssueListResponse;
        setIssues(json.rows);
        setTotal(json.total);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load issues');
      } finally {
        if (opts?.silent) {
          setRefreshing(false);
        }
      }
    },
    [filter],
  );

  useEffect(() => {
    if (refreshIntervalSec === null || refreshIntervalSec === 0) return;

    const id = window.setInterval(() => {
      void fetchIssues({ silent: true });
    }, refreshIntervalSec * 1000);

    return () => window.clearInterval(id);
  }, [refreshIntervalSec, fetchIssues]);

  function updateRefreshInterval(next: IssueListRefreshIntervalSec) {
    setRefreshIntervalSec(next);
    writeIssueListRefreshPrefs({ refreshIntervalSec: next });
  }

  const countLabel =
    total === 0
      ? emptyMessage
      : `${total} issue${total === 1 ? '' : 's'}${
          total > ISSUE_KANBAN_LIMIT ? ` (showing first ${ISSUE_KANBAN_LIMIT})` : ''
        }`;

  const toolbarActions = (
    <>
      <select
        id="issue-refresh-interval"
        aria-label="Auto-refresh interval"
        className="h-8 rounded-md border border-input bg-background px-2.5 text-sm"
        disabled={refreshIntervalSec === null}
        value={refreshIntervalSec ?? 0}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (isIssueListRefreshInterval(n)) updateRefreshInterval(n);
        }}
      >
        {ISSUE_LIST_REFRESH_INTERVALS.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>

      {refreshIntervalSec === 0 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={refreshIntervalSec === null || refreshing}
          onClick={() => void fetchIssues({ silent: true })}
        >
          <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      )}
    </>
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {countLabel}
        {refreshing && <span className="ml-2 text-xs">· Refreshing…</span>}
        {refreshIntervalSec !== null && refreshIntervalSec > 0 && (
          <span className="ml-2 text-xs">· Auto-refresh every {refreshIntervalSec}s</span>
        )}
      </p>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <IssueViewControls
        toolbarActions={toolbarActions}
        listView={
          <IssueTable
            issues={issues}
            agents={agents}
            total={total}
            emptyMessage={emptyMessage}
          />
        }
        kanbanView={<IssueBoard issues={issues} columns={[...visibleStatuses]} />}
      />
    </div>
  );
}
