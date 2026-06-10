import { PageHeader } from '@/components/page-header';
import { listGoalOptions } from '@/lib/goals';
import { listProjectOptions } from '@/lib/projects';
import {
  ISSUE_KANBAN_LIMIT,
  listIssueAgentOptions,
  listIssues,
} from '@/lib/issues';
import { NewIssueDialog } from './new-issue-dialog';
import { IssueBoard } from './issue-board';
import { IssueTable } from './issue-table';
import { IssueViewControls } from './issue-view-controls';
import {
  IssueStatusFilter,
  parseIssueFilter,
  parseIssuePage,
  statusesForFilter,
  type IssueFilter,
} from './issue-status-filter';

export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; page?: string }>;
}) {
  const { filter: filterParam, page: pageParam } = await searchParams;
  const filter = parseIssueFilter(filterParam);
  const page = parseIssuePage(pageParam);
  const visibleStatuses = statusesForFilter(filter);

  const [listResult, kanbanResult, agentList, goalList, projectList] = await Promise.all([
    listIssues({ statuses: visibleStatuses, page }),
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

      <IssueViewControls
        listView={
          <IssueTable
            issues={listResult.rows}
            filter={filter}
            page={listResult.page}
            total={listResult.total}
            pageSize={listResult.pageSize}
            emptyMessage={emptyMsg}
          />
        }
        kanbanView={
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {kanbanResult.total === 0
                ? emptyMsg
                : `${kanbanResult.total} issue${kanbanResult.total === 1 ? '' : 's'}${
                    kanbanResult.total > ISSUE_KANBAN_LIMIT
                      ? ` (showing first ${ISSUE_KANBAN_LIMIT})`
                      : ''
                  }`}
            </p>
            <IssueBoard issues={kanbanResult.rows} columns={[...visibleStatuses]} />
          </div>
        }
      />
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
    case 'active':
      return 'No active issues.';
    case 'all':
      return 'No issues yet.';
  }
}
