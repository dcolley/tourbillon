export const OBSERVABILITY_LIST_REFRESH_STORAGE_KEY = 'tourbillon:observability-list-refresh';

/** 0 = manual refresh only */
export type ObservabilityListRefreshIntervalSec = 0 | 5 | 15 | 30 | 60;

export const OBSERVABILITY_LIST_REFRESH_INTERVALS: Array<{
  value: ObservabilityListRefreshIntervalSec;
  label: string;
}> = [
  { value: 0, label: 'None' },
  { value: 5, label: '5s' },
  { value: 15, label: '15s' },
  { value: 30, label: '30s' },
  { value: 60, label: '60s' },
];

export interface ObservabilityListRefreshPrefs {
  refreshIntervalSec: ObservabilityListRefreshIntervalSec;
}

const DEFAULT_PREFS: ObservabilityListRefreshPrefs = {
  refreshIntervalSec: 0,
};

export function isObservabilityListRefreshInterval(
  value: number,
): value is ObservabilityListRefreshIntervalSec {
  return value === 0 || value === 5 || value === 15 || value === 30 || value === 60;
}

export function readObservabilityListRefreshPrefs(): ObservabilityListRefreshPrefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem(OBSERVABILITY_LIST_REFRESH_STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<ObservabilityListRefreshPrefs>;
    return {
      refreshIntervalSec:
        typeof parsed.refreshIntervalSec === 'number' &&
        isObservabilityListRefreshInterval(parsed.refreshIntervalSec)
          ? parsed.refreshIntervalSec
          : DEFAULT_PREFS.refreshIntervalSec,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function writeObservabilityListRefreshPrefs(prefs: ObservabilityListRefreshPrefs): void {
  localStorage.setItem(OBSERVABILITY_LIST_REFRESH_STORAGE_KEY, JSON.stringify(prefs));
}
