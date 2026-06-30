export const ISSUE_LIST_REFRESH_STORAGE_KEY = 'tourbillon:issue-list-refresh';

/** 0 = manual refresh only */
export type IssueListRefreshIntervalSec = 0 | 5 | 15 | 30 | 60;

export const ISSUE_LIST_REFRESH_INTERVALS: Array<{
  value: IssueListRefreshIntervalSec;
  label: string;
}> = [
  { value: 0, label: 'None' },
  { value: 5, label: '5s' },
  { value: 15, label: '15s' },
  { value: 30, label: '30s' },
  { value: 60, label: '60s' },
];

export interface IssueListRefreshPrefs {
  refreshIntervalSec: IssueListRefreshIntervalSec;
}

const DEFAULT_PREFS: IssueListRefreshPrefs = {
  refreshIntervalSec: 0,
};

export function isIssueListRefreshInterval(value: number): value is IssueListRefreshIntervalSec {
  return value === 0 || value === 5 || value === 15 || value === 30 || value === 60;
}

export function readIssueListRefreshPrefs(): IssueListRefreshPrefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem(ISSUE_LIST_REFRESH_STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<IssueListRefreshPrefs>;
    return {
      refreshIntervalSec:
        typeof parsed.refreshIntervalSec === 'number' &&
        isIssueListRefreshInterval(parsed.refreshIntervalSec)
          ? parsed.refreshIntervalSec
          : DEFAULT_PREFS.refreshIntervalSec,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function writeIssueListRefreshPrefs(prefs: IssueListRefreshPrefs): void {
  localStorage.setItem(ISSUE_LIST_REFRESH_STORAGE_KEY, JSON.stringify(prefs));
}
