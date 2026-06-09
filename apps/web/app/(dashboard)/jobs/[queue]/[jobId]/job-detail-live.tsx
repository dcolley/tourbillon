'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { HeartbeatRunSnapshot, JobLiveSnapshot, JobState } from '@/lib/jobs';
import { StatusBadge } from '@/lib/status-badges';

const LIVE_STATES = new Set(['waiting', 'active']);
const TERMINAL_STATES = new Set(['completed', 'failed', 'delayed']);

function shouldPoll(state: string): boolean {
  return LIVE_STATES.has(state);
}

function formatTime(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString() : '—';
}

interface JobDetailLiveProps {
  queue: string;
  jobId: string;
  listState: JobState;
  initial: JobLiveSnapshot;
  retryJobAction: (formData: FormData) => Promise<void>;
  removeJobAction: (formData: FormData) => Promise<void>;
}

export function JobDetailLive({
  queue,
  jobId,
  listState,
  initial,
  retryJobAction,
  removeJobAction,
}: JobDetailLiveProps) {
  const [snapshot, setSnapshot] = useState(initial);
  const [polling, setPolling] = useState(shouldPoll(initial.state));
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!polling) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${queue}/${jobId}/live`);
        if (!res.ok) return;

        const data = (await res.json()) as JobLiveSnapshot;
        setSnapshot(data);

        if (TERMINAL_STATES.has(data.state)) {
          setPolling(false);
        }
      } catch {
        // ignore transient fetch errors while polling
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [polling, queue, jobId]);

  useEffect(() => {
    if (polling && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [snapshot.logs, polling]);

  return (
    <>
      {snapshot.heartbeatRun && <HeartbeatRunSection run={snapshot.heartbeatRun} />}

      <section className="grid grid-cols-2 gap-4 text-sm">
        <DetailField label="State" value={snapshot.state} badge />
        <DetailField label="Attempts" value={String(snapshot.attemptsMade)} />
        <DetailField label="Created" value={formatTime(snapshot.timestamp)} />
        <DetailField label="Processed" value={formatTime(snapshot.processedOn)} />
        <DetailField label="Finished" value={formatTime(snapshot.finishedOn)} />
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Log</h2>
          {polling && (
            <span className="text-xs text-muted-foreground">Live — refreshing every 2s</span>
          )}
        </div>
        {snapshot.logs.length === 0 ? (
          <p className="border rounded-lg p-4 text-sm text-muted-foreground bg-muted/30">
            No log entries yet.
          </p>
        ) : (
          <pre
            ref={preRef}
            className="border rounded-lg p-4 text-xs font-mono overflow-x-auto overflow-y-auto max-h-96 bg-muted/30"
          >
            {snapshot.logs.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">
                <span className="text-muted-foreground select-none mr-2">{i + 1}.</span>
                {line}
              </div>
            ))}
          </pre>
        )}
      </section>

      <div className="flex gap-2">
        {snapshot.state === 'failed' && (
          <form action={retryJobAction}>
            <input type="hidden" name="queue" value={queue} />
            <input type="hidden" name="jobId" value={jobId} />
            <input type="hidden" name="state" value={listState} />
            <button
              type="submit"
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Retry
            </button>
          </form>
        )}
        <form action={removeJobAction}>
          <input type="hidden" name="queue" value={queue} />
          <input type="hidden" name="jobId" value={jobId} />
          <input type="hidden" name="state" value={listState} />
          <button
            type="submit"
            className="inline-flex items-center justify-center rounded-md border border-destructive px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10"
          >
            Remove
          </button>
        </form>
      </div>
    </>
  );
}

function hasContextSnapshot(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.keys(value).length > 0;
}

function HeartbeatRunSection({ run }: { run: HeartbeatRunSnapshot }) {
  return (
    <section className="border rounded-lg divide-y text-sm">
      <div className="p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Heartbeat run</h2>
          <StatusBadge status={run.status} />
        </div>
        <p className="font-mono text-xs text-muted-foreground mt-1 break-all">{run.id}</p>
      </div>

      <div className="grid grid-cols-2 gap-px bg-border">
        <RunField label="Run status" value={run.status} />
        <RunField label="Wake source" value={run.invocationSource.replace(/_/g, ' ')} />
        <RunField label="Started" value={new Date(run.startedAt).toLocaleString()} />
        <RunField
          label="Finished"
          value={run.finishedAt ? new Date(run.finishedAt).toLocaleString() : '—'}
        />
      </div>

      {run.agent && (
        <div className="p-4 space-y-1">
          <p className="text-xs text-muted-foreground">Agent</p>
          <Link href={`/agent/${run.agent.urlKey}`} className="font-medium hover:underline">
            {run.agent.name}
          </Link>
          <p className="text-muted-foreground">{run.agent.title}</p>
        </div>
      )}

      {run.taskId && (
        <Link
          href={`/issue/${run.taskId}`}
          className="flex items-center justify-between gap-4 p-4 hover:bg-accent/50 transition-colors"
        >
          <span>Assigned issue</span>
          <span className="font-mono text-xs text-muted-foreground">{run.taskId}</span>
        </Link>
      )}

      {run.errorText && (
        <div className="p-4 text-destructive text-sm">{run.errorText}</div>
      )}

      {hasContextSnapshot(run.contextSnapshot) && (
          <details className="p-4">
            <summary className="text-xs font-semibold cursor-pointer">Run context</summary>
            <pre className="mt-2 text-xs font-mono bg-muted rounded-md p-3 overflow-x-auto">
              {JSON.stringify(run.contextSnapshot, null, 2)}
            </pre>
          </details>
        )}
    </section>
  );
}

function DetailField({
  label,
  value,
  badge,
}: {
  label: string;
  value: string;
  badge?: boolean;
}) {
  return (
    <div className="border rounded-lg p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      {badge ? (
        <div className="mt-1">
          <StatusBadge status={value} />
        </div>
      ) : (
        <p className="font-medium mt-0.5 capitalize">{value}</p>
      )}
    </div>
  );
}

function RunField({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium mt-0.5 capitalize">{value}</p>
    </div>
  );
}
