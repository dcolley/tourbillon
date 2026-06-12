export const HEARTBEAT_LIST_STORAGE_KEY = 'tourbillon:heartbeat-list';

export type HeartbeatListFilter =
  | 'all'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'queued'
  | 'in_queue';

export const HEARTBEAT_LIST_FILTERS: Array<{ value: HeartbeatListFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'in_queue', label: 'In queue' },
  { value: 'running', label: 'Running' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'failed', label: 'Failed' },
  { value: 'queued', label: 'Queued' },
];

/** 0 = manual refresh only */
export type HeartbeatRefreshIntervalSec = 0 | 5 | 15 | 30 | 60;

export const HEARTBEAT_REFRESH_INTERVALS: Array<{
  value: HeartbeatRefreshIntervalSec;
  label: string;
}> = [
  { value: 0, label: 'None' },
  { value: 5, label: '5s' },
  { value: 15, label: '15s' },
  { value: 30, label: '30s' },
  { value: 60, label: '60s' },
];

export type HeartbeatPageSize = 10 | 25 | 50 | 100;

export const HEARTBEAT_PAGE_SIZES: HeartbeatPageSize[] = [10, 25, 50, 100];

export interface HeartbeatListPrefs {
  filter: HeartbeatListFilter;
  page: number;
  pageSize: HeartbeatPageSize;
  agentUrlKey: string | null;
  refreshIntervalSec: HeartbeatRefreshIntervalSec;
}

const DEFAULT_PREFS: HeartbeatListPrefs = {
  filter: 'all',
  page: 0,
  pageSize: 25,
  agentUrlKey: null,
  refreshIntervalSec: 0,
};

export function isHeartbeatPageSize(value: number): value is HeartbeatPageSize {
  return HEARTBEAT_PAGE_SIZES.includes(value as HeartbeatPageSize);
}

export function isHeartbeatRefreshInterval(value: number): value is HeartbeatRefreshIntervalSec {
  return value === 0 || value === 5 || value === 15 || value === 30 || value === 60;
}

export function isHeartbeatListFilter(value: string): value is HeartbeatListFilter {
  return ['all', 'running', 'succeeded', 'failed', 'queued', 'in_queue'].includes(value);
}

/** Map legacy BullMQ / URL state params to heartbeat list filters. */
export function mapLegacyUrlState(state: string): HeartbeatListFilter {
  switch (state) {
    case 'waiting':
    case 'delayed':
    case 'in_queue':
      return 'in_queue';
    case 'active':
    case 'running':
      return 'running';
    case 'completed':
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'queued':
      return 'queued';
    default:
      return isHeartbeatListFilter(state) ? state : 'all';
  }
}

export function readHeartbeatListPrefs(): HeartbeatListPrefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem(HEARTBEAT_LIST_STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<HeartbeatListPrefs>;
    return {
      filter: parsed.filter && isHeartbeatListFilter(parsed.filter) ? parsed.filter : DEFAULT_PREFS.filter,
      page: typeof parsed.page === 'number' && parsed.page >= 0 ? parsed.page : 0,
      agentUrlKey: typeof parsed.agentUrlKey === 'string' ? parsed.agentUrlKey : null,
      pageSize:
        typeof parsed.pageSize === 'number' && isHeartbeatPageSize(parsed.pageSize)
          ? parsed.pageSize
          : DEFAULT_PREFS.pageSize,
      refreshIntervalSec:
        typeof parsed.refreshIntervalSec === 'number' &&
        isHeartbeatRefreshInterval(parsed.refreshIntervalSec)
          ? parsed.refreshIntervalSec
          : DEFAULT_PREFS.refreshIntervalSec,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function writeHeartbeatListPrefs(prefs: HeartbeatListPrefs): void {
  localStorage.setItem(HEARTBEAT_LIST_STORAGE_KEY, JSON.stringify(prefs));
}

export function parseUrlHeartbeatPrefs(search: string): Partial<HeartbeatListPrefs> | null {
  const params = new URLSearchParams(search);
  const state = params.get('status') ?? params.get('state');
  const agent = params.get('agent');
  const page = params.get('page');

  if (!state && !agent && !page) return null;

  const patch: Partial<HeartbeatListPrefs> = {};
  if (state) patch.filter = mapLegacyUrlState(state);
  if (agent) patch.agentUrlKey = agent;
  if (page) {
    const n = parseInt(page, 10);
    if (Number.isFinite(n) && n >= 0) patch.page = n;
  }
  return patch;
}
