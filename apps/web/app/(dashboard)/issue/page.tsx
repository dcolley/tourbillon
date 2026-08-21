import { Suspense } from 'react';
import { BOARD_USER_ID } from '@tourbillon/shared';
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
import { ChatPageContext } from '@/components/chat/chat-page-context';

export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter: filterParam } = await searchParams;
  const filter = parseIssueFilter(filterParam);
  const visibleStatuses = statusesForFilter(filter);

  const [issueResult, agentList, goalList, projectList] = await Promise.all([
    listIssues({
      statuses: visibleStatuses,
      page: 0,
      pageSize: ISSUE_KANBAN_LIMIT,
      assigneeUserId: filter === 'mine' ? BOARD_USER_ID : undefined,
    }),
    listIssueAgentOptions(),
    listGoalOptions(true),
    listProjectOptions(),
  ]);

  const emptyMsg = emptyMessage(filter);

  // Board room: use first available agent as default, or leave unpinned
  const defaultAgent = agentList.length > 0 ? agentList[0] : null;

  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading issues…</p>}>
      <ChatPageContext
        contextType="board"
        contextTitle="Issue Board"
        defaultAgentId={defaultAgent?.id}
        defaultAgentName={defaultAgent?.name}
      />
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
    </Suspense>
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
    case 'mine':
      return 'No issues assigned to you (Board).';
    case 'in_review':
      return 'No issues in review.';
    case 'blocked':
      return 'No blocked issues.';
    case 'all':
      return 'No issues yet.';
  }
}
