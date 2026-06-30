import { ISSUE_KANBAN_LIMIT, type IssueListRow } from '@/lib/issue-list';
import { IssueTableClient } from './issue-table-client';

interface AgentOption {
  id: string;
  name: string;
  urlKey: string;
}

export function IssueTable({
  issues,
  agents,
  total,
  emptyMessage,
}: {
  issues: IssueListRow[];
  agents: AgentOption[];
  total: number;
  emptyMessage: string;
}) {
  return (
    <IssueTableClient
      issues={issues}
      agents={agents}
      total={total}
      limit={ISSUE_KANBAN_LIMIT}
      emptyMessage={emptyMessage}
    />
  );
}
