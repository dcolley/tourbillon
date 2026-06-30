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
import {
  buildEventTimeline,
  extractModelChunkOutput,
  extractModelInferenceSummary,
  extractModelStepOutput,
  formatEventPreview,
  formatJsonText,
  formatPayloadForDisplay,
  isModelChunkEvent,
  isModelInferenceEvent,
  isModelStepEvent,
  shortId,
  summarizePromptMessage,
} from '@/lib/observability-display';
import { MarkdownContent } from '@/components/markdown-content';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StatusBadge } from '@/lib/status-badges';
import { RefreshCw } from 'lucide-react';
import {
  OBSERVABILITY_LIST_REFRESH_INTERVALS,
  isObservabilityListRefreshInterval,
  readObservabilityListRefreshPrefs,
  writeObservabilityListRefreshPrefs,
  type ObservabilityListRefreshIntervalSec,
} from '@/lib/observability-list-refresh-storage';

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
  jobId: string;
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
  model_inference: 'Provider call',
  model_chunk: 'Model chunk',
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
    jobId: '',
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
  if (filters.jobId) params.set('jobId', filters.jobId);
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
  /** Lock heartbeat run filter (heartbeat job detail tab). */
  fixedHeartbeatRunId?: string;
  /** Lock BullMQ job id when run is not created yet. */
  fixedJobId?: string;
  showIssueColumn?: boolean;
  showAgentColumn?: boolean;
  showPageHeader?: boolean;
}

export function ObservabilityListClient({
  agents,
  goals = [],
  projects = [],
  fixedIssueId,
  fixedAgentId,
  fixedHeartbeatRunId,
  fixedJobId,
  showIssueColumn = true,
  showAgentColumn = true,
  showPageHeader = true,
}: ObservabilityListClientProps) {
  const [refreshIntervalSec, setRefreshIntervalSec] =
    useState<ObservabilityListRefreshIntervalSec | null>(null);
  const [filters, setFilters] = useState<ObservabilityFilters>(() =>
    defaultFilters({
      ...(fixedIssueId ? { issueId: fixedIssueId } : {}),
      ...(fixedAgentId ? { agentId: fixedAgentId } : {}),
      ...(fixedHeartbeatRunId ? { heartbeatRunId: fixedHeartbeatRunId } : {}),
      ...(fixedJobId ? { jobId: fixedJobId } : {}),
    })
  );
  const [data, setData] = useState<ObservabilityListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    setRefreshIntervalSec(readObservabilityListRefreshPrefs().refreshIntervalSec);
  }, []);

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
    setFilters((prev) => ({
      ...prev,
      ...(fixedIssueId ? { issueId: fixedIssueId } : { issueId: prev.issueId }),
      ...(fixedAgentId ? { agentId: fixedAgentId } : {}),
      heartbeatRunId: fixedHeartbeatRunId ?? '',
      jobId: fixedJobId ?? '',
      page: 0,
    }));
  }, [fixedIssueId, fixedAgentId, fixedHeartbeatRunId, fixedJobId]);

  useEffect(() => {
    void fetchList(filters);
  }, [filters, fetchList]);

  useEffect(() => {
    if (refreshIntervalSec === null || refreshIntervalSec === 0) return;
    const interval = setInterval(() => {
      void fetchList(filters, { silent: true });
    }, refreshIntervalSec * 1000);
    return () => clearInterval(interval);
  }, [refreshIntervalSec, filters, fetchList]);

  function updateRefreshInterval(next: ObservabilityListRefreshIntervalSec) {
    setRefreshIntervalSec(next);
    writeObservabilityListRefreshPrefs({ refreshIntervalSec: next });
  }

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
      patch.jobId !== undefined ||
      patch.search !== undefined ||
      patch.from !== undefined ||
      patch.to !== undefined ||
      patch.pageSize !== undefined;

    setFilters((prev) => ({
      ...prev,
      ...patch,
      ...(fixedIssueId ? { issueId: fixedIssueId } : {}),
      ...(fixedAgentId ? { agentId: fixedAgentId } : {}),
      ...(fixedHeartbeatRunId ? { heartbeatRunId: fixedHeartbeatRunId, jobId: '' } : {}),
      ...(fixedJobId ? { jobId: fixedJobId, heartbeatRunId: '' } : {}),
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

      {(fixedIssueId || fixedAgentId || fixedHeartbeatRunId || fixedJobId) && (
        <p className="text-sm text-muted-foreground">
          Live tokens (this page): {liveTokenTotals.input} in / {liveTokenTotals.output} out
          {refreshIntervalSec !== null && refreshIntervalSec > 0 && refreshing ? ' · updating…' : ''}
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

        {!fixedHeartbeatRunId && (
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
        )}
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
            disabled={loading || refreshIntervalSec === null}
            value={refreshIntervalSec ?? 0}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (isObservabilityListRefreshInterval(n)) updateRefreshInterval(n);
            }}
          >
            {OBSERVABILITY_LIST_REFRESH_INTERVALS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
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
                        <td className="px-4 py-3 max-w-xs truncate text-xs text-muted-foreground" title={formatEventPreview(event)}>
                          {formatEventPreview(event)}
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
  const timeline = buildEventTimeline(event);
  const payloadDisplay = formatPayloadForDisplay(event.payload);
  const [showRawPayload, setShowRawPayload] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);

  const modelStep = isModelStepEvent(event.eventType, event.name)
    ? extractModelStepOutput(event.payload)
    : null;
  const modelInference = isModelInferenceEvent(event.eventType, event.name)
    ? extractModelInferenceSummary(event.payload, event.name)
    : null;
  const modelChunk = isModelChunkEvent(event.eventType, event.name)
    ? extractModelChunkOutput(event.payload, event.name)
    : null;

  const showModelStepBlocks = modelStep != null;
  const showInferenceBlock = modelInference != null && !showModelStepBlocks;
  const showChunkBlock = modelChunk != null && !showModelStepBlocks && !showInferenceBlock;

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          Trace:{' '}
          <button
            type="button"
            className="font-mono text-primary hover:underline"
            title={event.traceId}
            onClick={() => onTraceFilter(event.traceId)}
          >
            {shortId(event.traceId)}
          </button>
        </span>
        <span className="font-mono" title={event.spanId}>
          Span: {shortId(event.spanId)}
        </span>
        {event.heartbeatRunId && (
          <span className="font-mono" title={event.heartbeatRunId}>
            Run: {shortId(event.heartbeatRunId)}
          </span>
        )}
        {event.jobId && (
          <span className="font-mono" title={event.jobId}>
            Job: {shortId(event.jobId)}
          </span>
        )}
      </div>

      {event.errorText && (
        <p className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
          {event.errorText}
        </p>
      )}

      {showModelStepBlocks && modelStep && (
        <ModelStepDetail modelStep={modelStep} showPrompt={showPrompt} onTogglePrompt={() => setShowPrompt((v) => !v)} />
      )}

      {showInferenceBlock && modelInference && (
        <ModelInferenceDetail summary={modelInference} />
      )}

      {showChunkBlock && modelChunk && (
        <ModelChunkDetail chunk={modelChunk} />
      )}

      {timeline.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">Activity</p>
          <ul className="space-y-1.5 rounded border bg-background p-3 text-xs">
            {timeline.map((entry, index) => (
              <li key={index} className="flex gap-2">
                <span
                  className={`shrink-0 font-mono ${
                    entry.kind === 'tool_call'
                      ? 'text-blue-600 dark:text-blue-400'
                      : entry.kind === 'tool_result'
                        ? entry.isError
                          ? 'text-destructive'
                          : 'text-green-600 dark:text-green-400'
                        : entry.kind === 'reasoning'
                          ? 'text-violet-600 dark:text-violet-400'
                          : entry.kind === 'text'
                            ? 'text-foreground'
                            : entry.kind === 'error'
                              ? 'text-destructive'
                              : 'text-muted-foreground'
                  }`}
                >
                  {entry.kind === 'tool_call'
                    ? '→'
                    : entry.kind === 'tool_result'
                      ? entry.isError
                        ? '✗'
                        : '←'
                      : entry.kind === 'reasoning'
                        ? '~'
                        : entry.kind === 'text'
                          ? '"'
                          : entry.kind === 'error'
                            ? '!'
                            : '·'}
                </span>
                <div className="min-w-0">
                  <span
                    className={
                      entry.isError ? 'font-medium text-destructive' : 'font-medium'
                    }
                  >
                    {entry.label}
                  </span>
                  {entry.detail && entry.kind !== 'text' && entry.kind !== 'reasoning' && (
                    <p className="text-muted-foreground mt-0.5 break-words whitespace-pre-wrap">
                      {entry.detail}
                    </p>
                  )}
                  {entry.detail && entry.kind === 'reasoning' && (
                    <p className="text-muted-foreground mt-0.5 break-words whitespace-pre-wrap font-mono text-[11px] italic">
                      {entry.detail.length > 600
                        ? `${entry.detail.slice(0, 600)}…`
                        : entry.detail}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {timeline.length === 0 && !showModelStepBlocks && !showInferenceBlock && !showChunkBlock && event.outputPreview && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1">Output</p>
          <pre className="rounded border bg-background p-3 text-xs overflow-x-auto whitespace-pre-wrap font-mono">
            {formatJsonText(event.outputPreview)}
          </pre>
        </div>
      )}

      {timeline.length === 0 &&
        !showModelStepBlocks &&
        !showInferenceBlock &&
        !showChunkBlock &&
        !event.outputPreview &&
        event.inputPreview && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1">Input</p>
          <pre className="rounded border bg-background p-3 text-xs overflow-x-auto whitespace-pre-wrap font-mono">
            {formatJsonText(event.inputPreview)}
          </pre>
        </div>
      )}

      {Object.keys(event.payload).length > 0 && (
        <div>
          <button
            type="button"
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
            onClick={() => setShowRawPayload((v) => !v)}
          >
            {showRawPayload ? 'Hide raw payload' : 'Show raw payload'}
            {payloadDisplay.isTruncated ? ' (truncated at storage limit)' : ''}
          </button>
          {showRawPayload && (
            <div className="mt-2 space-y-3">
              <pre className="rounded border bg-background p-3 text-xs overflow-x-auto max-h-96 whitespace-pre-wrap font-mono">
                {payloadDisplay.json}
              </pre>
              {payloadDisplay.previewFormatted && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">
                    Preview (formatted)
                  </p>
                  <pre className="rounded border bg-background p-3 text-xs overflow-x-auto max-h-[32rem] whitespace-pre-wrap font-mono">
                    {payloadDisplay.previewFormatted}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ModelStepDetail({
  modelStep,
  showPrompt,
  onTogglePrompt,
}: {
  modelStep: NonNullable<ReturnType<typeof extractModelStepOutput>>;
  showPrompt: boolean;
  onTogglePrompt: () => void;
}) {
  const hasReasoningTokens = modelStep.reasoningTokens != null && modelStep.reasoningTokens > 0;

  return (
    <div className="space-y-3">
      {(modelStep.stepIndex != null || modelStep.finishReason) && (
        <div className="flex flex-wrap gap-2 text-xs">
          {modelStep.stepIndex != null && (
            <span className="rounded bg-muted px-2 py-0.5 font-mono">Step {modelStep.stepIndex}</span>
          )}
          {modelStep.finishReason && (
            <span className="rounded bg-muted px-2 py-0.5">finish: {modelStep.finishReason}</span>
          )}
          {modelStep.outputTokens != null && (
            <span className="rounded bg-muted px-2 py-0.5">{modelStep.outputTokens} output tok</span>
          )}
        </div>
      )}

      {modelStep.text?.trim() && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">Response</p>
          <div className="rounded border bg-background p-3 text-xs max-h-96 overflow-y-auto prose prose-sm dark:prose-invert max-w-none">
            <MarkdownContent content={modelStep.text.trim()} />
          </div>
        </div>
      )}

      {modelStep.toolCalls.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">Tool calls</p>
          <ul className="space-y-2 rounded border bg-background p-3 text-xs">
            {modelStep.toolCalls.map((call, index) => {
              const name = call.toolName ?? call.name ?? 'tool';
              const argsJson =
                call.args && Object.keys(call.args as object).length > 0
                  ? JSON.stringify(call.args, null, 2)
                  : null;
              return (
                <li key={call.toolCallId ?? `${name}-${index}`}>
                  <span className="font-mono font-medium text-blue-600 dark:text-blue-400">
                    {name}
                  </span>
                  {argsJson && (
                    <pre className="mt-1 text-muted-foreground overflow-x-auto whitespace-pre-wrap font-mono text-[11px]">
                      {argsJson}
                    </pre>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {modelStep.inputMessages && modelStep.inputMessages.length > 0 && (
        <div>
          <button
            type="button"
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
            onClick={onTogglePrompt}
          >
            {showPrompt ? 'Hide prompt' : `View prompt (${modelStep.inputMessages.length} messages)`}
          </button>
          {showPrompt && (
            <ul className="mt-2 space-y-1.5 rounded border bg-background p-3 text-xs max-h-64 overflow-y-auto">
              {modelStep.inputMessages.map((msg, index) => (
                <li key={index} className="flex gap-2">
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase">
                    {msg.role}
                  </span>
                  <span className="text-muted-foreground break-words">
                    {summarizePromptMessage(msg.content)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!hasReasoningTokens && (
        <p className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
          No reasoning tokens reported for this step. To capture streamed reasoning text, set{' '}
          <code className="font-mono text-[11px]">OBSERVABILITY_STORE_MODEL_CHUNKS=true</code> and
          look for <span className="font-medium">Model chunk</span> events with type reasoning.
        </p>
      )}
    </div>
  );
}

function ModelInferenceDetail({
  summary,
}: {
  summary: NonNullable<ReturnType<typeof extractModelInferenceSummary>>;
}) {
  return (
    <div className="rounded border bg-background p-3 text-xs space-y-2">
      <p className="font-medium">Provider call (latency only)</p>
      <p className="text-muted-foreground">
        This span measures model latency and token usage. Response text and tool calls are stored on
        the sibling <span className="font-medium">Model step</span> event
        {summary.stepIndex != null ? ` for step ${summary.stepIndex}` : ''}.
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
        {summary.stepIndex != null && (
          <>
            <dt>Step</dt>
            <dd className="font-mono">{summary.stepIndex}</dd>
          </>
        )}
        {summary.finishReason && (
          <>
            <dt>Finish</dt>
            <dd>{summary.finishReason}</dd>
          </>
        )}
        {summary.inputTokens != null && (
          <>
            <dt>Input tokens</dt>
            <dd className="font-mono">{summary.inputTokens}</dd>
          </>
        )}
        {summary.outputTokens != null && (
          <>
            <dt>Output tokens</dt>
            <dd className="font-mono">{summary.outputTokens}</dd>
          </>
        )}
        {summary.completionStartTime && (
          <>
            <dt>First token</dt>
            <dd className="font-mono">{summary.completionStartTime}</dd>
          </>
        )}
        {summary.availableToolCount != null && (
          <>
            <dt>Tools available</dt>
            <dd className="font-mono">{summary.availableToolCount}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function ModelChunkDetail({
  chunk,
}: {
  chunk: NonNullable<ReturnType<typeof extractModelChunkOutput>>;
}) {
  const isReasoning = chunk.chunkType === 'reasoning';

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">
        {isReasoning ? 'Reasoning chunk' : `Chunk: ${chunk.chunkType}`}
      </p>
      {chunk.text?.trim() ? (
        isReasoning ? (
          <pre className="rounded border bg-background p-3 text-xs max-h-96 overflow-y-auto whitespace-pre-wrap font-mono italic text-muted-foreground">
            {chunk.text.trim()}
          </pre>
        ) : chunk.chunkType === 'text' ? (
          <div className="rounded border bg-background p-3 text-xs max-h-96 overflow-y-auto prose prose-sm dark:prose-invert max-w-none">
            <MarkdownContent content={chunk.text.trim()} />
          </div>
        ) : (
          <pre className="rounded border bg-background p-3 text-xs max-h-96 overflow-y-auto whitespace-pre-wrap font-mono">
            {chunk.text.trim()}
          </pre>
        )
      ) : (
        <p className="text-xs text-muted-foreground">(empty chunk)</p>
      )}
    </div>
  );
}
