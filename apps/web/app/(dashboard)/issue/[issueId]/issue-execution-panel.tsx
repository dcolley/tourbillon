'use client';

import { useEffect, useState } from 'react';
import { JobLogPanel } from '../../jobs/[queue]/[jobId]/job-log-panel';

interface IssueExecutionPanelProps {
  queue: string;
  jobId: string;
  jobState: string;
}

export function IssueExecutionPanel({ queue, jobId, jobState }: IssueExecutionPanelProps) {
  const [initialLogs, setInitialLogs] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/jobs/${queue}/${jobId}/logs`);
        if (!res.ok) return;
        const data = (await res.json()) as { logs: string[] };
        if (!cancelled) setInitialLogs(data.logs);
      } catch {
        // ignore
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [queue, jobId]);

  if (initialLogs === null) {
    return (
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Execution log</h2>
        <p className="border rounded-lg p-4 text-sm text-muted-foreground bg-muted/30">
          Loading execution log…
        </p>
      </section>
    );
  }

  return (
    <JobLogPanel
      queue={queue}
      jobId={jobId}
      initialLogs={initialLogs}
      initialState={jobState}
    />
  );
}
