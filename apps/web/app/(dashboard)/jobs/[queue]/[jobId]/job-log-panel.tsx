'use client';

import { useEffect, useRef, useState } from 'react';
import type { JobLiveSnapshot } from '@/lib/jobs';

interface JobLogPanelProps {
  queue: string;
  jobId: string;
  initialLogs: string[];
  initialState: string;
}

const LIVE_STATES = new Set(['waiting', 'active']);
const TERMINAL_STATES = new Set(['completed', 'failed', 'delayed']);

function shouldPoll(state: string): boolean {
  return LIVE_STATES.has(state);
}

export function JobLogPanel({ queue, jobId, initialLogs, initialState }: JobLogPanelProps) {
  const [logs, setLogs] = useState(initialLogs);
  const [state, setState] = useState(initialState);
  const [polling, setPolling] = useState(shouldPoll(initialState));
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!polling) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${queue}/${jobId}/live`);
        if (!res.ok) return;

        const data = (await res.json()) as JobLiveSnapshot;
        setLogs(data.logs);
        setState(data.state);

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
  }, [logs, polling]);

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Log</h2>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="capitalize">{state}</span>
          {polling && <span>Live — refreshing every 2s</span>}
        </div>
      </div>
      {logs.length === 0 ? (
        <p className="border rounded-lg p-4 text-sm text-muted-foreground bg-muted/30">
          No log entries yet.
        </p>
      ) : (
        <pre
          ref={preRef}
          className="border rounded-lg p-4 text-xs font-mono overflow-x-auto overflow-y-auto max-h-96 bg-muted/30"
        >
          {logs.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              <span className="text-muted-foreground select-none mr-2">{i + 1}.</span>
              {line}
            </div>
          ))}
        </pre>
      )}
    </section>
  );
}
