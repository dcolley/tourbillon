import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { PriorityBadge, StatusBadge } from '@/lib/status-badges';
import type { IssueListRow } from '@/lib/issues';
import { issueListHref, type IssueFilter } from './issue-status-filter';

export function IssueTable({
  issues,
  filter,
  page,
  total,
  pageSize,
  emptyMessage,
}: {
  issues: IssueListRow[];
  filter: IssueFilter;
  page: number;
  total: number;
  pageSize: number;
  emptyMessage: string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min((page + 1) * pageSize, total);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {total === 0 ? emptyMessage : `Showing ${from}–${to} of ${total}`}
      </p>

      <Card className="overflow-x-auto">
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left">
                <th className="px-4 py-3 font-medium">ID</th>
                <th className="px-4 py-3 font-medium">Title</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Priority</th>
                <th className="px-4 py-3 font-medium">Assignee</th>
                <th className="px-4 py-3 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {issues.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    {emptyMessage}
                  </td>
                </tr>
              ) : (
                issues.map(({ issue, agent }) => (
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
                      {issue.updatedAt.toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {pageCount > 1 && (
        <div className="flex items-center justify-between gap-4">
          <Link
            href={issueListHref(filter, page - 1)}
            aria-disabled={page <= 0}
            className={`inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium ${
              page <= 0 ? 'pointer-events-none opacity-40' : 'hover:bg-accent'
            }`}
          >
            ← Previous
          </Link>
          <span className="text-sm text-muted-foreground">
            Page {page + 1} of {pageCount}
          </span>
          <Link
            href={issueListHref(filter, page + 1)}
            aria-disabled={page >= pageCount - 1}
            className={`inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium ${
              page >= pageCount - 1 ? 'pointer-events-none opacity-40' : 'hover:bg-accent'
            }`}
          >
            Next →
          </Link>
        </div>
      )}
    </div>
  );
}
