import { listGoalOptions } from '@/lib/goals';
import { listProjectOptions } from '@/lib/projects';
import {
  ISSUE_KANBAN_LIMIT,
  listIssueAgentOptions,
  listIssues,
} from '@/lib/issues';
import { IssueListShell } from './issue-list-shell';
import {
  parseIssueFilter,
  statusesForFilter,
  type IssueFilter,
} from './issue-filter';

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
    <IssueListShell
      filter={filter}
      visibleStatuses={visibleStatuses}
      initialIssues={issueResult.rows}
      initialTotal={issueResult.total}
      agents={agentList}
      goals={goalList}
      projects={projectList}
      emptyMessage={emptyMsg}
    />
  );
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
