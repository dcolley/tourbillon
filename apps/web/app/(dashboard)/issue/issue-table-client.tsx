'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PriorityBadge, StatusBadge } from '@/lib/status-badges';
import type { IssueListRow } from '@/lib/issue-list';
import { compareIssueIdentifiers } from '@/lib/issue-identifiers';
import { ALL_STATUSES } from './issue-status-filter';
import {
  ISSUE_TABLE_PAGE_SIZES,
  ISSUE_TABLE_PRIORITY_FILTERS,
  ISSUE_TABLE_UNASSIGNED,
  readIssueTablePrefs,
  writeIssueTablePrefs,
  isIssueTablePageSize,
  isIssueTablePriorityFilter,
  type IssueTablePrefs,
  type IssueTableSortColumn,
} from '@/lib/issue-list-storage';

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const STATUS_ORDER = Object.fromEntries(ALL_STATUSES.map((status, index) => [status, index]));

interface AgentOption {
  id: string;
  name: string;
  urlKey: string;
}

function toTimestamp(value: Date | string): number {
  return new Date(value).getTime();
}

function compareRows(
  a: IssueListRow,
  b: IssueListRow,
  column: IssueTableSortColumn,
  direction: IssueTablePrefs['sortDirection'],
): number {
  const factor = direction === 'asc' ? 1 : -1;

  switch (column) {
    case 'identifier':
      return factor * compareIssueIdentifiers(a.issue.identifier, b.issue.identifier);
    case 'title':
      return factor * a.issue.title.localeCompare(b.issue.title);
    case 'status':
      return (
        factor *
        ((STATUS_ORDER[a.issue.status] ?? 99) - (STATUS_ORDER[b.issue.status] ?? 99))
      );
    case 'priority':
      return (
        factor *
        ((PRIORITY_ORDER[a.issue.priority] ?? 99) - (PRIORITY_ORDER[b.issue.priority] ?? 99))
      );
    case 'assignee': {
      const aName = a.agent?.name ?? '';
      const bName = b.agent?.name ?? '';
      return factor * aName.localeCompare(bName);
    }
    case 'updated':
      return factor * (toTimestamp(a.issue.updatedAt) - toTimestamp(b.issue.updatedAt));
  }
}

function filterRows(rows: IssueListRow[], prefs: IssueTablePrefs): IssueListRow[] {
  const query = prefs.search.trim().toLowerCase();

  return rows.filter(({ issue, agent }) => {
    if (prefs.priority && issue.priority !== prefs.priority) return false;

    if (prefs.assigneeKey === ISSUE_TABLE_UNASSIGNED) {
      if (agent) return false;
    } else if (prefs.assigneeKey && agent?.urlKey !== prefs.assigneeKey) {
      return false;
    }

    if (!query) return true;

    return (
      issue.title.toLowerCase().includes(query) ||
      issue.identifier.toLowerCase().includes(query)
    );
  });
}

export function IssueTableClient({
  issues,
  agents,
  total,
  limit,
  emptyMessage,
}: {
  issues: IssueListRow[];
  agents: AgentOption[];
  total: number;
  limit: number;
  emptyMessage: string;
}) {
  const [prefs, setPrefs] = useState<IssueTablePrefs | null>(null);

  useEffect(() => {
    setPrefs(readIssueTablePrefs());
  }, []);

  const filtered = useMemo(
    () => (prefs ? filterRows(issues, prefs) : issues),
    [issues, prefs],
  );

  const sorted = useMemo(() => {
    if (!prefs) return filtered;
    return [...filtered].sort((a, b) => compareRows(a, b, prefs.sortColumn, prefs.sortDirection));
  }, [filtered, prefs]);

  const page = prefs?.page ?? 0;
  const pageSize = prefs?.pageSize ?? 25;
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const from = sorted.length === 0 ? 0 : safePage * pageSize + 1;
  const to = Math.min((safePage + 1) * pageSize, sorted.length);

  function updatePrefs(patch: Partial<IssueTablePrefs>) {
    if (!prefs) return;
    const filtersChanged =
      patch.search !== undefined ||
      patch.priority !== undefined ||
      patch.assigneeKey !== undefined ||
      patch.pageSize !== undefined;
    const next: IssueTablePrefs = {
      ...prefs,
      ...patch,
      page: patch.page !== undefined ? patch.page : filtersChanged ? 0 : prefs.page,
    };
    writeIssueTablePrefs(next);
    setPrefs(next);
  }

  function toggleSort(column: IssueTableSortColumn) {
    if (!prefs) return;
    if (prefs.sortColumn === column) {
      updatePrefs({
        sortColumn: column,
        sortDirection: prefs.sortDirection === 'asc' ? 'desc' : 'asc',
        page: 0,
      });
      return;
    }
    updatePrefs({
      sortColumn: column,
      sortDirection: column === 'updated' ? 'desc' : 'asc',
      page: 0,
    });
  }

  function sortIcon(column: IssueTableSortColumn) {
    if (!prefs || prefs.sortColumn !== column) {
      return <ArrowUpDown className="ml-1 inline size-3.5 opacity-40" />;
    }
    return prefs.sortDirection === 'asc' ? (
      <ArrowUp className="ml-1 inline size-3.5" />
    ) : (
      <ArrowDown className="ml-1 inline size-3.5" />
    );
  }

  const truncated = total > limit;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
        <div className="min-w-[14rem] flex-1 space-y-1.5">
          <label htmlFor="issue-table-search" className="text-xs font-medium text-muted-foreground">
            Search
          </label>
          <Input
            id="issue-table-search"
            placeholder="Title or ID…"
            disabled={!prefs}
            value={prefs?.search ?? ''}
            onChange={(e) => updatePrefs({ search: e.target.value })}
          />
        </div>

        <div className="space-y-1.5 min-w-[10rem]">
          <label htmlFor="issue-table-priority" className="text-xs font-medium text-muted-foreground">
            Priority
          </label>
          <select
            id="issue-table-priority"
            className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm"
            disabled={!prefs}
            value={prefs?.priority ?? ''}
            onChange={(e) => {
              const value = e.target.value;
              if (isIssueTablePriorityFilter(value)) updatePrefs({ priority: value });
            }}
          >
            {ISSUE_TABLE_PRIORITY_FILTERS.map(({ value, label }) => (
              <option key={value || 'all'} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5 min-w-[12rem]">
          <label htmlFor="issue-table-assignee" className="text-xs font-medium text-muted-foreground">
            Assignee
          </label>
          <select
            id="issue-table-assignee"
            className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm"
            disabled={!prefs}
            value={prefs?.assigneeKey ?? ''}
            onChange={(e) =>
              updatePrefs({
                assigneeKey: e.target.value ? e.target.value : null,
              })
            }
          >
            <option value="">All assignees</option>
            <option value={ISSUE_TABLE_UNASSIGNED}>Unassigned</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.urlKey}>
                {agent.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        {!prefs
          ? 'Loading…'
          : sorted.length === 0
            ? emptyMessage
            : `Showing ${from}–${to} of ${sorted.length}${sorted.length !== issues.length ? ` (filtered from ${issues.length})` : ''}`}
        {prefs && truncated && (
          <span className="ml-1">
            · {total} total{total > limit ? ` (table limited to first ${limit})` : ''}
          </span>
        )}
      </p>

      <Card className="overflow-x-auto">
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left">
                {(
                  [
                    ['identifier', 'ID'],
                    ['title', 'Title'],
                    ['status', 'Status'],
                    ['priority', 'Priority'],
                    ['assignee', 'Assignee'],
                    ['updated', 'Updated'],
                  ] as const
                ).map(([column, label]) => (
                  <th key={column} className="px-4 py-3 font-medium">
                    <button
                      type="button"
                      className="inline-flex items-center hover:text-foreground disabled:opacity-50"
                      disabled={!prefs}
                      onClick={() => toggleSort(column)}
                    >
                      {label}
                      {sortIcon(column)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {!prefs ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              ) : pageRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    {sorted.length === 0 && issues.length > 0
                      ? 'No issues match these filters.'
                      : emptyMessage}
                  </td>
                </tr>
              ) : (
                pageRows.map(({ issue, agent }) => (
                  <tr key={issue.id} className="hover:bg-accent/30">
                    <td className="px-4 py-3">
                      <Link
                        href={`/issue/${issue.id}`}
                        className="font-mono text-xs text-primary hover:underline"
                      >
                        {issue.identifier}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/issue/${issue.id}`} className="font-medium hover:underline">
                        {issue.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={issue.status} />
                    </td>
                    <td className="px-4 py-3">
                      <PriorityBadge priority={issue.priority} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {agent ? (
                        <Link href={`/agent/${agent.urlKey}`} className="hover:underline">
                          {agent.name}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                      {new Date(issue.updatedAt).toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {prefs && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-sm">
            <label htmlFor="issue-table-page-size" className="text-muted-foreground whitespace-nowrap">
              Rows per page
            </label>
            <select
              id="issue-table-page-size"
              className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              value={prefs.pageSize}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (isIssueTablePageSize(n)) updatePrefs({ pageSize: n });
              }}
            >
              {ISSUE_TABLE_PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>

          {pageCount > 1 && (
            <div className="flex items-center justify-between gap-4 sm:justify-end">
              <Button
                variant="outline"
                size="sm"
                disabled={safePage <= 0}
                onClick={() => updatePrefs({ page: safePage - 1 })}
              >
                ← Previous
              </Button>
              <span className="text-sm text-muted-foreground whitespace-nowrap">
                Page {safePage + 1} of {pageCount}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={safePage >= pageCount - 1}
                onClick={() => updatePrefs({ page: safePage + 1 })}
              >
                Next →
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
