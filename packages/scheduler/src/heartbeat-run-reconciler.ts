import { QueueEvents } from 'bullmq';
import { and, eq, lt } from 'drizzle-orm';
import { createTraceLogger, QUEUE_HEARTBEAT } from '@tourbillon/shared';
import { db, heartbeatRuns, reconcileRunningHeartbeatRunsForJob } from '@tourbillon/db';
import { createConnection } from './redis';
import { heartbeatQueue } from './heartbeat-queue';

const tracer = createTraceLogger('heartbeat-reconciler', {});

async function reconcileRunningRun(jobId: string, errorText: string): Promise<void> {
  const runIds = await reconcileRunningHeartbeatRunsForJob(jobId, errorText);
  if (runIds.length > 0) {
    tracer.info('reconciled stale heartbeat run', { jobId, runIds, errorText });
  }
}

function jobIdFromSnapshot(snapshot: unknown): string | undefined {
  return (snapshot as { jobId?: string } | null)?.jobId;
}

export async function startReconciler(): Promise<void> {
  const activeJobs = await heartbeatQueue.getActive();
  const activeJobIds = new Set(activeJobs.map((j) => j.id));

  const staleRuns = await db.query.heartbeatRuns.findMany({
    where: eq(heartbeatRuns.status, 'running'),
  });

  for (const run of staleRuns) {
    const jobId = jobIdFromSnapshot(run.contextSnapshot);
    if (jobId && !activeJobIds.has(jobId)) {
      await reconcileRunningRun(jobId, 'stale on worker restart');
      tracer.info('swept stale run on startup', { jobId, runId: run.id });
    }
  }

  const connection = createConnection();
  const queueEvents = new QueueEvents(QUEUE_HEARTBEAT, { connection });

  queueEvents.on('stalled', ({ jobId }) => {
    void reconcileRunningRun(jobId, 'BullMQ job stalled').catch((err) => {
      tracer.error('failed to reconcile stalled job', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  queueEvents.on('failed', ({ jobId }) => {
    void reconcileRunningRun(jobId, 'BullMQ job failed').catch((err) => {
      tracer.error('failed to reconcile failed job', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  queueEvents.on('removed', ({ jobId }) => {
    void reconcileRunningRun(jobId, 'BullMQ job removed').catch((err) => {
      tracer.error('failed to reconcile removed job', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  setInterval(() => {
    void (async () => {
      const cutoff = new Date(Date.now() - 5 * 60_000);
      const agedRuns = await db.query.heartbeatRuns.findMany({
        where: and(
          eq(heartbeatRuns.status, 'running'),
          lt(heartbeatRuns.startedAt, cutoff),
        ),
      });
      for (const run of agedRuns) {
        const jobId = jobIdFromSnapshot(run.contextSnapshot);
        if (!jobId) continue;
        const job = await heartbeatQueue.getJob(jobId);
        const state = job ? await job.getState() : 'unknown';
        if (state !== 'active') {
          await reconcileRunningRun(jobId, `periodic sweep: job in state ${state}`);
        }
      }
    })().catch((err) => {
      tracer.error('periodic staleness sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, 60_000);

  tracer.info('started', { queue: QUEUE_HEARTBEAT });
}
