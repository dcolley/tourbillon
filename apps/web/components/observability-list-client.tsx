'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  OBSERVABILITY_EVENT_STATUSES,
  OBSERVABILITY_EVENT_TYPES,
  type ObservabilityEventStatus,
  type ObservabilityEventType,
} from '@tourbillon/shared/observability';
import {
  OBSERVABILITY_PAGE_SIZES,
  isObservabilityPageSize,
  type ObservabilityEventRow,
} from '@/lib/observability-types';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StatusBadge } from '@/lib/status-badges';
import { RefreshCw } from 'lucide-react';

interface AgentOption {
  id: string;
  name: string;
}

interface GoalOption {
  id: string;
  title: string;
}

interface ProjectOption {
  id: string;
  title: string;
}

interface ObservabilityFilters {
  issueId: string;
  projectId: string;
  goalId: string;
  agentId: string;
  eventType: ObservabilityEventType | '';
  status: ObservabilityEventStatus | '';
  traceId: string;
  heartbeatRunId: string;
  search: string;
  from: string;
  to: string;
  page: number;
  pageSize: number;
}

interface ObservabilityListResponse {
  events: ObservabilityEventRow[];
  total: number;
  page: number;
  pageSize: number;
}

const EVENT_TYPE_LABELS: Record<ObservabilityEventType, string> = {
  agent_run: 'Agent run',
  model_generation: 'Model generation',
  model_step: 'Model step',
  tool_call: 'Tool call',
  mcp_tool_call: 'MCP tool',
  generic: 'Generic',
  text_delta: 'Text delta',
  tool_call_start: 'Tool call start',
  tool_call_result: 'Tool result',
  tool_suspended: 'Tool suspended',
  tool_approval_required: 'Tool approval',
  subagent_spawn: 'Subagent spawn',
  subagent_done: 'Subagent done',
  subagent_start: 'Subagent start',
  subagent_end: 'Subagent end',
  om_observation: 'OM observation',
  om_reflection: 'OM reflection',
  agent_done: 'Agent done',
  usage_update: 'Token usage',
  mode_switch: 'Mode switch',
  error: 'Error',
};

const REFRESH_INTERVALS = [
  { label: 'Manual only', ms: 0 },
  { label: 'Every 1s', ms: 1000 },
  { label: 'Every 2s', ms: 2000 },
  { label: 'Every 5s', ms: 5000 },
  { label: 'Every 10s', ms: 10000 },
  { label: 'Every 30s', ms: 30000 },
] as const;

function defaultFilters(overrides?: Partial<ObservabilityFilters>): ObservabilityFilters {
  return {
    issueId: '',
    projectId: '',
    goalId: '',
    agentId: '',
    eventType: '',
    status: '',
    traceId: '',
    heartbeatRunId: '',
    search: '',
    from: '',
    to: '',
    page: 0,
    pageSize: 25,
    ...overrides,
  };
}

function buildQueryParams(filters: ObservabilityFilters): URLSearchParams {
  const params = new URLSearchParams();
  params.set('page', String(filters.page));
  params.set('pageSize', String(filters.pageSize));
  if (filters.issueId) params.set('issueId', filters.issueId);
  if (filters.projectId) params.set('projectId', filters.projectId);
  if (filters.goalId) params.set('goalId', filters.goalId);
  if (filters.agentId) params.set('agentId', filters.agentId);
  if (filters.eventType) params.set('eventType', filters.eventType);
  if (filters.status) params.set('status', filters.status);
  if (filters.traceId) params.set('traceId', filters.traceId);
  if (filters.heartbeatRunId) params.set('heartbeatRunId', filters.heartbeatRunId);
  if (filters.search) params.set('search', filters.search);
  if (filters.from) {
    const d = new Date(filters.from);
    if (!Number.isNaN(d.getTime())) params.set('from', d.toISOString());
  }
  if (filters.to) {
    const d = new Date(filters.to);
    if (!Number.isNaN(d.getTime())) params.set('to', d.toISOString());
  }
  return params;
}

export interface ObservabilityListClientProps {
  agents: AgentOption[];
  goals?: GoalOption[];
  projects?: ProjectOption[];
  /** Lock issue filter (issue detail tab). */
  fixedIssueId?: string;
  /** Lock agent filter (agent detail tab). */
  fixedAgentId?: string;
  showIssueColumn?: boolean;
  showAgentColumn?: boolean;
  showPageHeader?: boolean;
  /** Default auto-refresh interval in ms; 0 = manual only. */
  defaultRefreshIntervalMs?: number;
}

export function ObservabilityListClient({
  agents,
  goals = [],
  projects = [],
  fixedIssueId,
  fixedAgentId,
  showIssueColumn = true,
  showAgentColumn = true,
  showPageHeader = true,
  defaultRefreshIntervalMs = 0,
}: ObservabilityListClientProps) {
  const initialRefreshMs = REFRESH_INTERVALS.some((o) => o.ms === defaultRefreshIntervalMs)
    ? defaultRefreshIntervalMs
    : 0;
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(initialRefreshMs);
  const [filters, setFilters] = useState<ObservabilityFilters>(() =>
    defaultFilters({
      ...(fixedIssueId ? { issueId: fixedIssueId } : {}),
      ...(fixedAgentId ? { agentId: fixedAgentId } : {}),
    })
  );
  const [data, setData] = useState<ObservabilityListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchList = useCallback(
    async (next: ObservabilityFilters, opts?: { silent?: boolean }) => {
      if (opts?.silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const params = buildQueryParams(next);
        const res = await fetch(`/api/observability?${params}`);
        if (!res.ok) throw new Error(`Failed to load events (${res.status})`);
        const json = (await res.json()) as ObservabilityListResponse;
        setData(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load events');
        if (!opts?.silent) setData(null);
      } finally {
        if (opts?.silent) {
          setRefreshing(false);
        } else {
          setLoading(false);
        }
      }
    },
    []
  );

  useEffect(() => {
    void fetchList(filters);
  }, [filters, fetchList]);

  useEffect(() => {
    if (refreshIntervalMs <= 0) return;
    const interval = setInterval(() => {
      void fetchList(filters, { silent: true });
    }, refreshIntervalMs);
    return () => clearInterval(interval);
  }, [refreshIntervalMs, filters, fetchList]);

  function updateFilters(patch: Partial<ObservabilityFilters>) {
    const resetPage =
      patch.issueId !== undefined ||
      patch.projectId !== undefined ||
      patch.goalId !== undefined ||
      patch.agentId !== undefined ||
      patch.eventType !== undefined ||
      patch.status !== undefined ||
      patch.traceId !== undefined ||
      patch.heartbeatRunId !== undefined ||
      patch.search !== undefined ||
      patch.from !== undefined ||
      patch.to !== undefined ||
      patch.pageSize !== undefined;

    setFilters((prev) => ({
      ...prev,
      ...patch,
      ...(fixedIssueId ? { issueId: fixedIssueId } : {}),
      ...(fixedAgentId ? { agentId: fixedAgentId } : {}),
      page: patch.page !== undefined ? patch.page : resetPage ? 0 : prev.page,
    }));
  }

  const page = data?.page ?? filters.page;
  const pageSize = data?.pageSize ?? filters.pageSize;
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min((page + 1) * pageSize, total);

  const liveTokenTotals = (data?.events ?? []).reduce(
    (acc, event) => {
      if (event.eventType === 'usage_update') {
        acc.input += event.inputTokens ?? 0;
        acc.output += event.outputTokens ?? 0;
      }
      return acc;
    },
    { input: 0, output: 0 },
  );

  const selectClass =
    'w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm';
  const labelClass = 'text-xs font-medium text-muted-foreground';
  const tableColumnCount =
    8 + (showAgentColumn ? 1 : 0) + (showIssueColumn ? 1 : 0);

  return (
    <div className="space-y-6">
      {showPageHeader && (
        <>
          <PageHeader
            title="Observability"
            description="Agent spans exported from Mastra heartbeats — tool calls, model steps, and traces."
          />
        </>
      )}

      {(fixedIssueId || fixedAgentId) && (
        <p className="text-sm text-muted-foreground">
          Live tokens (this page): {liveTokenTotals.input} in / {liveTokenTotals.output} out
          {refreshIntervalMs > 0 && refreshing ? ' · updating…' : ''}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {!fixedIssueId && (
          <div className="space-y-1.5">
            <label htmlFor="obs-issue" className={labelClass}>
              Issue ID
            </label>
            <input
              id="obs-issue"
              type="text"
              className={selectClass}
              placeholder="Filter by issue"
              disabled={loading}
              value={filters.issueId}
              onChange={(e) => updateFilters({ issueId: e.target.value })}
            />
          </div>
        )}

        {goals.length > 0 && (
          <div className="space-y-1.5">
            <label htmlFor="obs-goal" className={labelClass}>
              Goal
            </label>
            <select
              id="obs-goal"
              className={selectClass}
              disabled={loading}
              value={filters.goalId}
              onChange={(e) => updateFilters({ goalId: e.target.value })}
            >
              <option value="">All goals</option>
              {goals.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
          </div>
        )}

        {projects.length > 0 && (
          <div className="space-y-1.5">
            <label htmlFor="obs-project" className={labelClass}>
              Project
            </label>
            <select
              id="obs-project"
              className={selectClass}
              disabled={loading}
              value={filters.projectId}
              onChange={(e) => updateFilters({ projectId: e.target.value })}
            >
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </div>
        )}

        {!fixedAgentId && (
          <div className="space-y-1.5">
            <label htmlFor="obs-agent" className={labelClass}>
              Agent
            </label>
            <select
              id="obs-agent"
              className={selectClass}
              disabled={loading}
              value={filters.agentId}
              onChange={(e) => updateFilters({ agentId: e.target.value })}
            >
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="space-y-1.5">
          <label htmlFor="obs-type" className={labelClass}>
            Event type
          </label>
          <select
            id="obs-type"
            className={selectClass}
            disabled={loading}
            value={filters.eventType}
            onChange={(e) =>
              updateFilters({ eventType: e.target.value as ObservabilityEventType | '' })
            }
          >
            <option value="">All types</option>
            {OBSERVABILITY_EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {EVENT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="obs-status" className={labelClass}>
            Status
          </label>
          <select
            id="obs-status"
            className={selectClass}
            disabled={loading}
            value={filters.status}
            onChange={(e) =>
              updateFilters({ status: e.target.value as ObservabilityEventStatus | '' })
            }
          >
            <option value="">All statuses</option>
            {OBSERVABILITY_EVENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="obs-from" className={labelClass}>
            From
          </label>
          <input
            id="obs-from"
            type="datetime-local"
            className={selectClass}
            disabled={loading}
            value={filters.from}
            onChange={(e) => updateFilters({ from: e.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="obs-to" className={labelClass}>
            To
          </label>
          <input
            id="obs-to"
            type="datetime-local"
            className={selectClass}
            disabled={loading}
            value={filters.to}
            onChange={(e) => updateFilters({ to: e.target.value })}
          />
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <label htmlFor="obs-search" className={labelClass}>
            Search
          </label>
          <input
            id="obs-search"
            type="text"
            className={selectClass}
            placeholder="Name, tool, preview, trace…"
            disabled={loading}
            value={filters.search}
            onChange={(e) => updateFilters({ search: e.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="obs-trace" className={labelClass}>
            Trace ID
          </label>
          <input
            id="obs-trace"
            type="text"
            className={selectClass}
            placeholder="Full trace id"
            disabled={loading}
            value={filters.traceId}
            onChange={(e) => updateFilters({ traceId: e.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="obs-run" className={labelClass}>
            Heartbeat run ID
          </label>
          <input
            id="obs-run"
            type="text"
            className={selectClass}
            placeholder="Run id"
            disabled={loading}
            value={filters.heartbeatRunId}
            onChange={(e) => updateFilters({ heartbeatRunId: e.target.value })}
          />
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {loading && !data
            ? 'Loading…'
            : total === 0
              ? 'No events match these filters.'
              : `Showing ${from}–${to} of ${total}`}
          {refreshing && data && <span className="ml-2 text-xs">· Refreshing…</span>}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="obs-refresh-interval" className="sr-only">
            Auto-refresh interval
          </label>
          <select
            id="obs-refresh-interval"
            className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            disabled={loading}
            value={refreshIntervalMs}
            onChange={(e) => setRefreshIntervalMs(parseInt(e.target.value, 10))}
          >
            {REFRESH_INTERVALS.map((option) => (
              <option key={option.ms} value={option.ms}>
                {option.label}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading || refreshing}
            onClick={() => void fetchList(filters, { silent: Boolean(data) })}
          >
            <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <Card className="overflow-x-auto">
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left">
                <th className="px-4 py-3 font-medium w-8" />
                <th className="px-4 py-3 font-medium">Time</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Name</th>
                {showAgentColumn && <th className="px-4 py-3 font-medium">Agent</th>}
                {showIssueColumn && <th className="px-4 py-3 font-medium">Issue</th>}
                <th className="px-4 py-3 font-medium">Duration</th>
                <th className="px-4 py-3 font-medium">Tokens</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Preview</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {loading && !data ? (
                <tr>
                  <td
                    colSpan={tableColumnCount}
                    className="px-4 py-8 text-center text-muted-foreground"
                  >
                    Loading events…
                  </td>
                </tr>
              ) : !data || data.events.length === 0 ? (
                <tr>
                  <td
                    colSpan={tableColumnCount}
                    className="px-4 py-8 text-center text-muted-foreground"
                  >
                    No observability events in this view.
                  </td>
                </tr>
              ) : (
                data.events.map((event) => {
                  const expanded = expandedId === event.id;
                  const tokenSummary =
                    event.inputTokens != null || event.outputTokens != null
                      ? `${event.inputTokens ?? 0} / ${event.outputTokens ?? 0}`
                      : '—';
                  return (
                    <Fragment key={event.id}>
                      <tr className="hover:bg-accent/30">
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-foreground"
                            aria-expanded={expanded}
                            onClick={() => setExpandedId(expanded ? null : event.id)}
                          >
                            {expanded ? '▼' : '▶'}
                          </button>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                          {new Date(event.occurredAt).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-xs capitalize">
                          {EVENT_TYPE_LABELS[event.eventType] ?? event.eventType}
                        </td>
                        <td className="px-4 py-3 max-w-[12rem] truncate" title={event.name}>
                          {event.toolId ?? event.name}
                          {event.model && (
                            <span className="block text-xs text-muted-foreground truncate">
                              {event.model}
                            </span>
                          )}
                        </td>
                        {showAgentColumn && (
                          <td className="px-4 py-3">
                            {event.agentName ?? (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        )}
                        {showIssueColumn && (
                          <td className="px-4 py-3">
                            {event.issueId ? (
                              <Link
                                href={`/issue/${event.issueId}`}
                                className="font-mono text-xs hover:underline"
                              >
                                {event.issueId.slice(0, 8)}…
                              </Link>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        )}
                        <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                          {event.durationMs != null ? `${event.durationMs}ms` : '—'}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">{tokenSummary}</td>
                        <td className="px-4 py-3">
                          <StatusBadge status={event.status} />
                        </td>
                        <td className="px-4 py-3 max-w-xs truncate text-xs text-muted-foreground">
                          {event.outputPreview ?? event.inputPreview ?? '—'}
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="bg-muted/20">
                          <td colSpan={tableColumnCount} className="px-4 py-4">
                            <ObservabilityEventDetail
                              event={event}
                              onTraceFilter={(traceId) => updateFilters({ traceId, page: 0 })}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-sm">
          <label htmlFor="obs-page-size" className="text-muted-foreground whitespace-nowrap">
            Rows per page
          </label>
          <select
            id="obs-page-size"
            className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            disabled={loading}
            value={filters.pageSize}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (isObservabilityPageSize(n)) updateFilters({ pageSize: n });
            }}
          >
            {OBSERVABILITY_PAGE_SIZES.map((size) => (
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
            onClick={() => updateFilters({ page: page - 1 })}
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
            onClick={() => updateFilters({ page: page + 1 })}
          >
            Next →
          </Button>
        </div>
      </div>
    </div>
  );
}

function ObservabilityEventDetail({
  event,
  onTraceFilter,
}: {
  event: ObservabilityEventRow;
  onTraceFilter: (traceId: string) => void;
}) {
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <span>
          Trace:{' '}
          <button
            type="button"
            className="font-mono text-primary hover:underline"
            onClick={() => onTraceFilter(event.traceId)}
          >
            {event.traceId}
          </button>
        </span>
        <span className="font-mono">Span: {event.spanId}</span>
        {event.heartbeatRunId && (
          <span className="font-mono">Run: {event.heartbeatRunId}</span>
        )}
        {event.jobId && <span className="font-mono">Job: {event.jobId}</span>}
      </div>

      {event.errorText && (
        <p className="text-destructive text-xs">{event.errorText}</p>
      )}

      {event.eventType === 'text_delta' && event.outputPreview && (
        <blockquote className="border-l-2 border-muted-foreground/40 pl-3 text-sm italic text-muted-foreground whitespace-pre-wrap">
          {event.outputPreview}
        </blockquote>
      )}

      {event.inputPreview && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1">Input preview</p>
          <pre className="rounded border bg-background p-3 text-xs overflow-x-auto whitespace-pre-wrap">
            {event.inputPreview}
          </pre>
        </div>
      )}

      {event.outputPreview && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1">Output preview</p>
          <pre className="rounded border bg-background p-3 text-xs overflow-x-auto whitespace-pre-wrap">
            {event.outputPreview}
          </pre>
        </div>
      )}

      {Object.keys(event.payload).length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1">Full payload</p>
          <pre className="rounded border bg-background p-3 text-xs overflow-x-auto max-h-96">
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
