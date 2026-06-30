import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { PriorityBadge } from '@/lib/status-badges';
import type { IssueListRow } from '@/lib/issue-list';

export function IssueBoard({
  issues: rows,
  columns,
}: {
  issues: IssueListRow[];
  columns: string[];
}) {
  const byStatus = columns.reduce(
    (acc, status) => {
      acc[status] = rows.filter((r) => r.issue.status === status);
      return acc;
    },
    {} as Record<string, IssueListRow[]>,
  );

  return (
    <div className="flex flex-col gap-6 md:flex-row md:gap-4 md:overflow-x-auto md:pb-4">
      {columns.map((status) => (
        <div key={status} className="w-full md:w-72 md:shrink-0">
          <div className="mb-2 flex items-center justify-between border-b pb-2 md:border-0 md:pb-0">
            <p className="text-sm font-semibold capitalize">{status.replace(/_/g, ' ')}</p>
            <span className="text-xs text-muted-foreground">{byStatus[status]?.length ?? 0}</span>
          </div>
          <div className="space-y-2">
            {(byStatus[status] ?? []).length === 0 ? (
              <Card>
                <CardContent className="p-4 text-center text-xs text-muted-foreground">Empty</CardContent>
              </Card>
            ) : (
              (byStatus[status] ?? []).map(({ issue, agent }) => (
                <IssueCard key={issue.id} issue={issue} agent={agent} />
              ))
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function IssueCard({ issue, agent }: IssueListRow) {
  return (
    <Link href={`/issue/${issue.id}`}>
      <Card className="transition-colors hover:bg-muted/50">
        <CardContent className="space-y-1 p-3">
          <p className="font-mono text-xs text-muted-foreground">{issue.identifier}</p>
          <p className="text-sm font-medium">{issue.title}</p>
          {agent && <p className="text-xs text-muted-foreground">{agent.name}</p>}
          <PriorityBadge priority={issue.priority} />
        </CardContent>
      </Card>
    </Link>
  );
}
