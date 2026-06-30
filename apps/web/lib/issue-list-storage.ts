export const ISSUE_TABLE_STORAGE_KEY = 'tourbillon:issue-table';

export type IssueTableSortColumn =
  | 'identifier'
  | 'title'
  | 'status'
  | 'priority'
  | 'assignee'
  | 'updated';

export type IssueTableSortDirection = 'asc' | 'desc';

export type IssueTablePageSize = 10 | 25 | 50 | 100;

export const ISSUE_TABLE_PAGE_SIZES: IssueTablePageSize[] = [10, 25, 50, 100];

export type IssueTablePriorityFilter = '' | 'critical' | 'high' | 'medium' | 'low';

export const ISSUE_TABLE_PRIORITY_FILTERS: Array<{
  value: IssueTablePriorityFilter;
  label: string;
}> = [
  { value: '', label: 'All priorities' },
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

export const ISSUE_TABLE_UNASSIGNED = '__unassigned__';

export interface IssueTablePrefs {
  sortColumn: IssueTableSortColumn;
  sortDirection: IssueTableSortDirection;
  search: string;
  priority: IssueTablePriorityFilter;
  assigneeKey: string | null;
  page: number;
  pageSize: IssueTablePageSize;
}

const DEFAULT_PREFS: IssueTablePrefs = {
  sortColumn: 'updated',
  sortDirection: 'desc',
  search: '',
  priority: '',
  assigneeKey: null,
  page: 0,
  pageSize: 25,
};

const SORT_COLUMNS: IssueTableSortColumn[] = [
  'identifier',
  'title',
  'status',
  'priority',
  'assignee',
  'updated',
];

export function isIssueTableSortColumn(value: string): value is IssueTableSortColumn {
  return SORT_COLUMNS.includes(value as IssueTableSortColumn);
}

export function isIssueTableSortDirection(value: string): value is IssueTableSortDirection {
  return value === 'asc' || value === 'desc';
}

export function isIssueTablePageSize(value: number): value is IssueTablePageSize {
  return ISSUE_TABLE_PAGE_SIZES.includes(value as IssueTablePageSize);
}

export function isIssueTablePriorityFilter(value: string): value is IssueTablePriorityFilter {
  return ['', 'critical', 'high', 'medium', 'low'].includes(value);
}

export function readIssueTablePrefs(): IssueTablePrefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem(ISSUE_TABLE_STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<IssueTablePrefs>;
    return {
      sortColumn:
        parsed.sortColumn && isIssueTableSortColumn(parsed.sortColumn)
          ? parsed.sortColumn
          : DEFAULT_PREFS.sortColumn,
      sortDirection:
        parsed.sortDirection && isIssueTableSortDirection(parsed.sortDirection)
          ? parsed.sortDirection
          : DEFAULT_PREFS.sortDirection,
      search: typeof parsed.search === 'string' ? parsed.search : DEFAULT_PREFS.search,
      priority:
        typeof parsed.priority === 'string' && isIssueTablePriorityFilter(parsed.priority)
          ? parsed.priority
          : DEFAULT_PREFS.priority,
      assigneeKey:
        parsed.assigneeKey === ISSUE_TABLE_UNASSIGNED
          ? ISSUE_TABLE_UNASSIGNED
          : typeof parsed.assigneeKey === 'string'
            ? parsed.assigneeKey
            : null,
      page: typeof parsed.page === 'number' && parsed.page >= 0 ? parsed.page : 0,
      pageSize:
        typeof parsed.pageSize === 'number' && isIssueTablePageSize(parsed.pageSize)
          ? parsed.pageSize
          : DEFAULT_PREFS.pageSize,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function writeIssueTablePrefs(prefs: IssueTablePrefs): void {
  localStorage.setItem(ISSUE_TABLE_STORAGE_KEY, JSON.stringify(prefs));
}
