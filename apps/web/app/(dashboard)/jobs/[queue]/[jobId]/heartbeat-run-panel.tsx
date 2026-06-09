import Link from 'next/link';
import type { HeartbeatRunWithAgent } from '@/lib/heartbeats';
import { getHeartbeatTaskId } from '@/lib/heartbeats';

export function HeartbeatRunPanel({ detail }: { detail: HeartbeatRunWithAgent }) {
  const { run, agent } = detail;
  const taskId = getHeartbeatTaskId(run);
  const snapshot = run.contextSnapshot as Record<string, unknown> | null;

  return (
    <section className="border rounded-lg divide-y text-sm">
      <div className="p-4">
        <h2 className="text-sm font-semibold">Heartbeat run</h2>
        <p className="font-mono text-xs text-muted-foreground mt-1 break-all">{run.id}</p>
      </div>

      <div className="grid grid-cols-2 gap-px bg-border">
        <RunField label="Run status" value={run.status} />
        <RunField label="Wake source" value={run.invocationSource.replace(/_/g, ' ')} />
        <RunField label="Started" value={run.startedAt.toLocaleString()} />
        <RunField
          label="Finished"
          value={run.finishedAt ? run.finishedAt.toLocaleString() : '—'}
        />
      </div>

      {agent && (
        <div className="p-4 space-y-1">
          <p className="text-xs text-muted-foreground">Agent</p>
          <Link href={`/agent/${agent.urlKey}`} className="font-medium hover:underline">
            {agent.name}
          </Link>
          <p className="text-muted-foreground">{agent.title}</p>
        </div>
      )}

      {taskId && (
        <Link
          href={`/issue/${taskId}`}
          className="flex items-center justify-between gap-4 p-4 hover:bg-accent/50 transition-colors"
        >
          <span>Assigned issue</span>
          <span className="font-mono text-xs text-muted-foreground">{taskId}</span>
        </Link>
      )}

      {run.errorText && (
        <div className="p-4 text-destructive text-sm">{run.errorText}</div>
      )}

      {snapshot && Object.keys(snapshot).length > 0 && (
        <details className="p-4">
          <summary className="text-xs font-semibold cursor-pointer">Run context</summary>
          <pre className="mt-2 text-xs font-mono bg-muted rounded-md p-3 overflow-x-auto">
            {JSON.stringify(snapshot, null, 2)}
          </pre>
        </details>
      )}
    </section>
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
