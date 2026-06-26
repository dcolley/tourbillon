'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  readHeartbeatListPrefs,
  writeHeartbeatListPrefs,
  parseUrlHeartbeatPrefs,
  HEARTBEAT_REFRESH_INTERVALS,
  HEARTBEAT_LIST_FILTERS,
  HEARTBEAT_PAGE_SIZES,
  isHeartbeatRefreshInterval,
  isHeartbeatPageSize,
  type HeartbeatListPrefs,
  type HeartbeatListFilter,
} from '@/lib/heartbeat-list-storage';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { StatusBadge } from '@/lib/status-badges';

interface AgentOption {
  id: string;
  name: string;
  urlKey: string;
  title: string;
}

interface HeartbeatListEntryJson {
  key: string;
  runId: string | null;
  jobId: string | null;
  agent: AgentOption | null;
  invocationSource: string | null;
  runStatus: string | null;
  jobState: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorText: string | null;
  href: string;
  source: 'db' | 'queue';
}

interface HeartbeatListResponse {
  entries: HeartbeatListEntryJson[];
  total: number;
  page: number;
  pageSize: number;
  filter: HeartbeatListFilter;
}

export function HeartbeatListClient({ agents }: { agents: AgentOption[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [prefs, setPrefs] = useState<HeartbeatListPrefs | null>(null);
  const [data, setData] = useState<HeartbeatListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hydrate prefs from localStorage; merge one-time URL params then strip query string.
  useEffect(() => {
    const stored = readHeartbeatListPrefs();
    const urlPatch = parseUrlHeartbeatPrefs(searchParams.toString());
    const merged: HeartbeatListPrefs = urlPatch
      ? {
          ...stored,
          filter: urlPatch.filter ?? stored.filter,
          page: urlPatch.page ?? stored.page,
          agentUrlKey: urlPatch.agentUrlKey ?? stored.agentUrlKey,
        }
      : stored;

    writeHeartbeatListPrefs(merged);
    setPrefs(merged);

    if (urlPatch && pathname) {
      router.replace(pathname, { scroll: false });
    }
  }, [pathname, router, searchParams]);

  const fetchList = useCallback(async (next: HeartbeatListPrefs, opts?: { silent?: boolean }) => {
    if (opts?.silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('filter', next.filter);
      params.set('page', String(next.page));
      params.set('pageSize', String(next.pageSize));
      if (next.agentUrlKey) params.set('agent', next.agentUrlKey);

      const res = await fetch(`/api/jobs/heartbeat/list?${params}`);
      if (!res.ok) throw new Error(`Failed to load heartbeats (${res.status})`);
      const json = (await res.json()) as HeartbeatListResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load heartbeats');
      if (!opts?.silent) setData(null);
    } finally {
      if (opts?.silent) {
        setRefreshing(false);
      } else {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!prefs) return;
    void fetchList(prefs);
  }, [prefs, fetchList]);

  useEffect(() => {
    if (!prefs || prefs.refreshIntervalSec === 0) return;

    const id = window.setInterval(() => {
      void fetchList(prefs, { silent: true });
    }, prefs.refreshIntervalSec * 1000);

    return () => window.clearInterval(id);
  }, [prefs, fetchList]);

  function updatePrefs(patch: Partial<HeartbeatListPrefs>) {
    if (!prefs) return;
    const resetPage =
      patch.filter !== undefined || patch.agentUrlKey !== undefined || patch.pageSize !== undefined;
    const next: HeartbeatListPrefs = {
      ...prefs,
      ...patch,
      page: patch.page !== undefined ? patch.page : resetPage ? 0 : prefs.page,
    };
    writeHeartbeatListPrefs(next);
    setPrefs(next);
  }

  const selectedAgent = prefs?.agentUrlKey
    ? agents.find((a) => a.urlKey === prefs.agentUrlKey) ?? null
    : null;

  const page = data?.page ?? prefs?.page ?? 0;
  const pageSize = data?.pageSize ?? prefs?.pageSize ?? 25;
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min((page + 1) * pageSize, total);

  return (
    <div className="space-y-6">
      {selectedAgent ? (
        <Link
          href={`/agent/${selectedAgent.urlKey}`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back to {selectedAgent.name}
        </Link>
      ) : (
        <Link href="/jobs" className="text-sm text-muted-foreground hover:text-foreground">
          ← All queues
        </Link>
      )}

      <PageHeader
        title="Heartbeats"
        description={
          selectedAgent
            ? `Runs for ${selectedAgent.name}`
            : 'Database runs augmented with live BullMQ job state'
        }
      />

      <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {HEARTBEAT_LIST_FILTERS.map(({ value, label }) => (
            <Button
              key={value}
              variant={prefs?.filter === value ? 'default' : 'outline'}
              size="sm"
              disabled={!prefs || loading}
              onClick={() => updatePrefs({ filter: value })}
            >
              {label}
            </Button>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5 min-w-[12rem]">
            <label htmlFor="heartbeat-agent-filter" className="text-xs font-medium text-muted-foreground">
              Agent
            </label>
            <select
              id="heartbeat-agent-filter"
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
              disabled={!prefs || loading}
              value={prefs?.agentUrlKey ?? ''}
              onChange={(e) => updatePrefs({ agentUrlKey: e.target.value || null })}
            >
              <option value="">All agents</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.urlKey}>
                  {agent.name} ({agent.title})
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5 min-w-[8rem]">
            <label htmlFor="heartbeat-refresh-interval" className="text-xs font-medium text-muted-foreground">
              Auto-refresh
            </label>
            <select
              id="heartbeat-refresh-interval"
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
              disabled={!prefs}
              value={prefs?.refreshIntervalSec ?? 0}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (isHeartbeatRefreshInterval(n)) {
                  updatePrefs({ refreshIntervalSec: n });
                }
              }}
            >
              {HEARTBEAT_REFRESH_INTERVALS.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {prefs?.refreshIntervalSec === 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!prefs || loading || refreshing}
              className="mb-0.5"
              onClick={() => prefs && void fetchList(prefs, { silent: Boolean(data) })}
            >
              <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        {loading && !data
          ? 'Loading…'
          : total === 0
            ? 'No heartbeats match this filter.'
            : `Showing ${from}–${to} of ${total}`}
        {refreshing && data && (
          <span className="ml-2 text-xs">· Refreshing…</span>
        )}
        {prefs && prefs.refreshIntervalSec > 0 && (
          <span className="ml-2 text-xs">· Auto-refresh every {prefs.refreshIntervalSec}s</span>
        )}
      </p>

      <Card className="overflow-x-auto">
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left">
                <th className="px-4 py-3 font-medium">Job ID</th>
                <th className="px-4 py-3 font-medium">Agent</th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Run</th>
                <th className="px-4 py-3 font-medium">Job</th>
                <th className="px-4 py-3 font-medium">Started</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {loading && !data ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    Loading heartbeats…
                  </td>
                </tr>
              ) : !data || data.entries.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    No heartbeats in this view.
                  </td>
                </tr>
              ) : (
                data.entries.map((entry) => (
                  <tr key={entry.key} className="hover:bg-accent/30">
                    <td className="px-4 py-3">
                      <Link
                        href={entry.href}
                        className="font-mono text-xs text-primary hover:underline break-all"
                      >
                        {entry.jobId ?? entry.runId?.slice(0, 8) ?? '—'}
                      </Link>
                      {entry.source === 'queue' && (
                        <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                          queue only
                        </span>
                      )}
                      {entry.errorText && (
                        <p className="text-xs text-destructive mt-1 truncate max-w-xs">{entry.errorText}</p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {entry.agent ? (
                        <Link href={`/agent/${entry.agent.urlKey}`} className="font-medium hover:underline">
                          {entry.agent.name}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 capitalize text-muted-foreground">
                      {entry.invocationSource?.replace(/_/g, ' ') ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      {entry.runStatus ? (
                        <StatusBadge status={entry.runStatus} />
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {entry.jobState ? (
                        <StatusBadge status={entry.jobState} />
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                      {entry.startedAt ? new Date(entry.startedAt).toLocaleString() : '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {prefs && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-sm">
            <label htmlFor="heartbeat-page-size" className="text-muted-foreground whitespace-nowrap">
              Rows per page
            </label>
            <select
              id="heartbeat-page-size"
              className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              disabled={loading}
              value={prefs.pageSize}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (isHeartbeatPageSize(n)) updatePrefs({ pageSize: n });
              }}
            >
              {HEARTBEAT_PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center justify-between gap-4 sm:justify-end">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 0 || loading}
              onClick={() => updatePrefs({ page: page - 1 })}
            >
              ← Previous
            </Button>
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              Page {page + 1} of {pageCount}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pageCount - 1 || loading}
              onClick={() => updatePrefs({ page: page + 1 })}
            >
              Next →
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
