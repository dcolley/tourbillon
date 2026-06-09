import Link from 'next/link';
import { db, issues, agents } from '@tourbillon/db';
import { desc, eq } from 'drizzle-orm';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { PriorityBadge, StatusBadge } from '@/lib/status-badges';
import { listGoalOptions } from '@/lib/goals';
import { listProjectOptions } from '@/lib/projects';
import { NewIssueDialog } from './new-issue-dialog';
import {
  IssueStatusFilter,
  parseIssueFilter,
  statusesForFilter,
  type IssueFilter,
} from './issue-status-filter';

type IssueRow = { issue: typeof issues.$inferSelect; agent: typeof agents.$inferSelect | null };

export default async function IssuesPage({
  searchParams,
}: {
  searchParams: { filter?: string };
}) {
  const filter = parseIssueFilter(searchParams.filter);
  const visibleStatuses = statusesForFilter(filter);

  const [allIssues, agentList, goalList, projectList] = await Promise.all([
    db
      .select({ issue: issues, agent: agents })
      .from(issues)
      .leftJoin(agents, eq(issues.assigneeAgentId, agents.id))
      .orderBy(desc(issues.updatedAt))
      .limit(200),
    db.select({ id: agents.id, name: agents.name, urlKey: agents.urlKey }).from(agents).orderBy(agents.name),
    listGoalOptions(true),
    listProjectOptions(),
  ]);

  const filteredIssues = allIssues.filter((r) => visibleStatuses.includes(r.issue.status));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Issues"
        description={filterDescription(filter)}
        actions={
          <NewIssueDialog
            agents={agentList}
            goals={goalList}
            projects={projectList}
            buttonLabel="Add issue"
          />
        }
      />

      <IssueStatusFilter current={filter} />

      <p className="text-sm text-muted-foreground">
        {filteredIssues.length} issue{filteredIssues.length === 1 ? '' : 's'}
      </p>

      {filter === 'completed' || filter === 'backlog' || filter === 'cancelled' ? (
        <IssueList issues={filteredIssues} emptyMessage={emptyMessage(filter)} />
      ) : (
        <IssueBoard issues={filteredIssues} columns={[...visibleStatuses]} />
      )}
    </div>
  );
}

function filterDescription(filter: IssueFilter): string {
  switch (filter) {
    case 'active':
      return 'Open work — todo, in progress, in review, and blocked';
    case 'completed':
      return 'Finished issues';
    case 'all':
      return 'Every issue by status';
    case 'backlog':
      return 'Backlog';
    case 'cancelled':
      return 'Cancelled issues';
  }
}

function emptyMessage(filter: IssueFilter): string {
  switch (filter) {
    case 'completed':
      return 'No completed issues yet.';
    case 'backlog':
      return 'No backlog issues.';
    case 'cancelled':
      return 'No cancelled issues.';
    default:
      return 'No issues found.';
  }
}

function IssueBoard({
  issues: rows,
  columns,
}: {
  issues: IssueRow[];
  columns: string[];
}) {
  const byStatus = columns.reduce(
    (acc, status) => {
      acc[status] = rows.filter((r) => r.issue.status === status);
      return acc;
    },
    {} as Record<string, IssueRow[]>
  );

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {columns.map((status) => (
        <div key={status} className="w-72 shrink-0">
          <div className="mb-2 flex items-center justify-between">
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

function IssueList({
  issues: rows,
  emptyMessage,
}: {
  issues: IssueRow[];
  emptyMessage: string;
}) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-muted-foreground">{emptyMessage}</CardContent>
      </Card>
    );
  }

  return (
    <Card className="max-w-2xl">
      <CardContent className="p-0">
        <div className="divide-y">
          {rows.map(({ issue, agent }) => (
            <Link
              key={issue.id}
              href={`/issue/${issue.id}`}
              className="flex items-start justify-between gap-4 p-4 transition-colors hover:bg-muted/50"
            >
              <div className="min-w-0 space-y-1">
                <p className="font-mono text-xs text-muted-foreground">{issue.identifier}</p>
                <p className="font-medium">{issue.title}</p>
                {agent && <p className="text-xs text-muted-foreground">{agent.name}</p>}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <StatusBadge status={issue.status} />
                <PriorityBadge priority={issue.priority} />
              </div>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function IssueCard({
  issue,
  agent,
}: {
  issue: typeof issues.$inferSelect;
  agent: typeof agents.$inferSelect | null;
}) {
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
