import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getHeartbeatRun,
  getHeartbeatTaskId,
  heartbeatJobListState,
} from '@/lib/heartbeats';
import {
  getJobLiveSnapshot,
  type JobState,
} from '@/lib/jobs';
import { JobDetailLive } from '../../jobs/[queue]/[jobId]/job-detail-live';

async function dismissHeartbeatAction(_formData: FormData) {
  'use server';
  // Heartbeat runs are immutable audit rows — no retry/remove from this page.
}

export default async function HeartbeatRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const detail = await getHeartbeatRun(runId);
  if (!detail) notFound();

  const liveSnapshot = await getJobLiveSnapshot('heartbeat', runId);
  if (!liveSnapshot) notFound();

  const { run, agent } = detail;
  const taskId = getHeartbeatTaskId(run);
  const listState = heartbeatJobListState(run) as JobState;

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div>
        <Link
          href="/jobs/heartbeat"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back to heartbeats
        </Link>
        <h1 className="text-2xl font-bold tracking-tight mt-2">Heartbeat</h1>
        <p className="font-mono text-sm text-muted-foreground mt-1 break-all">{run.id}</p>
        <p className="text-muted-foreground">
          {agent ? (
            <>
              <Link
                href={`/agent/${agent.urlKey}`}
                className="hover:text-foreground underline-offset-4 hover:underline"
              >
                {agent.name}
              </Link>
              {` · ${run.invocationSource}`}
            </>
          ) : (
            run.invocationSource
          )}
        </p>
        {taskId && (
          <p className="text-sm mt-1">
            <Link href={`/issue/${taskId}`} className="text-muted-foreground hover:underline">
              Linked issue
            </Link>
          </p>
        )}
      </div>

      {run.errorText && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {run.errorText}
        </div>
      )}

      <JobDetailLive
        queue="heartbeat"
        jobId={runId}
        listState={listState}
        initial={liveSnapshot}
        retryJobAction={dismissHeartbeatAction}
        removeJobAction={dismissHeartbeatAction}
      />

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Context</h2>
        <pre className="border rounded-lg p-4 text-xs font-mono overflow-x-auto bg-muted/30">
          {JSON.stringify(run.contextSnapshot, null, 2)}
        </pre>
      </section>
    </div>
  );
}
