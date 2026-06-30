import { PageHeader } from '@/components/page-header';
import { listGoalOptions } from '@/lib/goals';
import { listProjectOptions } from '@/lib/projects';
import {
  ISSUE_KANBAN_LIMIT,
  listIssueAgentOptions,
  listIssues,
} from '@/lib/issues';
import { NewIssueDialog } from './new-issue-dialog';
import { IssueListShell } from './issue-list-shell';
import {
  IssueStatusFilter,
  parseIssueFilter,
  statusesForFilter,
  type IssueFilter,
} from './issue-status-filter';

export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter: filterParam } = await searchParams;
  const filter = parseIssueFilter(filterParam);
  const visibleStatuses = statusesForFilter(filter);

  const [issueResult, agentList, goalList, projectList] = await Promise.all([
    listIssues({ statuses: visibleStatuses, page: 0, pageSize: ISSUE_KANBAN_LIMIT }),
    listIssueAgentOptions(),
    listGoalOptions(true),
    listProjectOptions(),
  ]);

  const emptyMsg = emptyMessage(filter);

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

      <IssueListShell
        filter={filter}
        visibleStatuses={visibleStatuses}
        initialIssues={issueResult.rows}
        initialTotal={issueResult.total}
        agents={agentList}
        emptyMessage={emptyMsg}
      />
    </div>
  );
}

function filterDescription(filter: IssueFilter): string {
  switch (filter) {
    case 'active':
      return 'Open work — todo, in progress, in review, and blocked';
    case 'in_review':
      return 'Issues awaiting review';
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
    case 'active':
      return 'No active issues.';
    case 'in_review':
      return 'No issues in review.';
    case 'all':
      return 'No issues yet.';
  }
}
