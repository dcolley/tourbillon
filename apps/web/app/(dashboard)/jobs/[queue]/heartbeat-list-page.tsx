import Link from 'next/link';
import { QUEUE_HEARTBEAT } from '@tourbillon/shared';
import {
  getHeartbeatList,
  HEARTBEAT_LIST_FILTERS,
  type HeartbeatListFilter,
} from '@/lib/heartbeats';
import { getAgentByUrlKey } from '@/lib/agents';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StatusBadge } from '@/lib/status-badges';

function parseFilter(value: string | undefined): HeartbeatListFilter {
  if (value && HEARTBEAT_LIST_FILTERS.some((f) => f.value === value)) {
    return value as HeartbeatListFilter;
  }
  return 'all';
}

function parsePage(value: string | undefined): number {
  const n = parseInt(value ?? '0', 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function listHref(filter: HeartbeatListFilter, page: number, agent?: string): string {
  const params = new URLSearchParams();
  if (filter !== 'all') params.set('status', filter);
  if (page > 0) params.set('page', String(page));
  if (agent) params.set('agent', agent);
  const qs = params.toString();
  return `/jobs/${QUEUE_HEARTBEAT}${qs ? `?${qs}` : ''}`;
}

export async function HeartbeatListPage({
  searchParams,
}: {
  searchParams: { status?: string; page?: string; agent?: string };
}) {
  const filter = parseFilter(searchParams.status);
  const page = parsePage(searchParams.page);
  const agentFilter = searchParams.agent
    ? await getAgentByUrlKey(searchParams.agent)
    : null;

  const { entries, total, pageSize } = await getHeartbeatList({
    filter,
    page,
    agentId: agentFilter?.id,
  });

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min((page + 1) * pageSize, total);

  return (
    <div className="space-y-6">
      {agentFilter ? (
        <Link
          href={`/agent/${agentFilter.urlKey}`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back to {agentFilter.name}
        </Link>
      ) : (
        <Link href="/jobs" className="text-sm text-muted-foreground hover:text-foreground">
          ← All queues
        </Link>
      )}

      <PageHeader
        title="Heartbeats"
        description={
          agentFilter
            ? `Runs for ${agentFilter.name}`
            : 'Database runs augmented with live BullMQ job state'
        }
      />

      <div className="flex flex-wrap gap-2">
        {HEARTBEAT_LIST_FILTERS.map(({ value, label }) => (
          <Button
            key={value}
            variant={filter === value ? 'default' : 'outline'}
            size="sm"
            render={<Link href={listHref(value, 0, searchParams.agent)} />}
          >
            {label}
          </Button>
        ))}
      </div>

      <p className="text-sm text-muted-foreground">
        {total === 0
          ? 'No heartbeats match this filter.'
          : `Showing ${from}–${to} of ${total}`}
      </p>

      <Card className="overflow-x-auto">
        <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left">
              <th className="px-4 py-3 font-medium">Agent</th>
              <th className="px-4 py-3 font-medium">Source</th>
              <th className="px-4 py-3 font-medium">Run</th>
              <th className="px-4 py-3 font-medium">Job</th>
              <th className="px-4 py-3 font-medium">Started</th>
              <th className="px-4 py-3 font-medium">Job ID</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {entries.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  No heartbeats in this view.
                </td>
              </tr>
            ) : (
              entries.map((entry) => (
                <tr key={entry.key} className="hover:bg-accent/30">
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
                    {entry.startedAt ? entry.startedAt.toLocaleString() : '—'}
                  </td>
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
                </tr>
              ))
            )}
          </tbody>
        </table>
        </CardContent>
      </Card>

      {pageCount > 1 && (
        <div className="flex items-center justify-between gap-4">
          <Link
            href={listHref(filter, page - 1, searchParams.agent)}
            aria-disabled={page <= 0}
            className={`inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium ${
              page <= 0 ? 'pointer-events-none opacity-40' : 'hover:bg-accent'
            }`}
          >
            ← Previous
          </Link>
          <span className="text-sm text-muted-foreground">
            Page {page + 1} of {pageCount}
          </span>
          <Link
            href={listHref(filter, page + 1, searchParams.agent)}
            aria-disabled={page >= pageCount - 1}
            className={`inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium ${
              page >= pageCount - 1 ? 'pointer-events-none opacity-40' : 'hover:bg-accent'
            }`}
          >
            Next →
          </Link>
        </div>
      )}
    </div>
  );
}

