import type { Issue } from '@tourbillon/db';

export const ISSUE_LIST_PAGE_SIZE = 25;
export const ISSUE_KANBAN_LIMIT = 500;

export type IssueListRow = {
  issue: Issue;
  agent: { id: string; name: string; urlKey: string } | null;
};

export interface IssueListResult {
  rows: IssueListRow[];
  total: number;
  page: number;
  pageSize: number;
}
