import { and, eq, lt, or, sql } from 'drizzle-orm';
import { QueueEvents } from 'bullmq';
import {
  createTraceLogger,
  heartbeatStaleErrorText,
  QUEUE_HEARTBEAT,
  resolveHeartbeatLivenessConfig,
} from '@tourbillon/shared';
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
  const jobId = (snapshot as { jobId?: string } | null)?.jobId;
  return typeof jobId === 'string' && jobId.length > 0 ? jobId : undefined;
}

function isRunStale(run: { lastSeenAt: Date | null; startedAt: Date }, cutoff: Date): boolean {
  const seenAt = run.lastSeenAt ?? run.startedAt;
  return seenAt < cutoff;
}

async function failOverStaleJob(jobId: string, errorText: string): Promise<void> {
  await reconcileRunningRun(jobId, errorText);

  const job = await heartbeatQueue.getJob(jobId);
  if (!job) return;

  const state = await job.getState();
  if (state !== 'active') return;

  const token = job.token;
  if (!token) {
    tracer.warn('cannot move stale active job to failed without lock token', { jobId });
    return;
  }

  try {
    await job.moveToFailed(new Error(errorText), token, false);
    tracer.info('moved stale active job to failed', { jobId });
  } catch (err) {
    tracer.error('failed to move stale active job to failed', {
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function startReconciler(): Promise<void> {
  const { staleSec } = resolveHeartbeatLivenessConfig();
  const cutoff = new Date(Date.now() - staleSec * 1000);
  const staleErrorText = heartbeatStaleErrorText(staleSec);

  const activeJobs = await heartbeatQueue.getActive();
  const activeJobIds = new Set(activeJobs.map((j) => j.id));

  const runningRuns = await db.query.heartbeatRuns.findMany({
    where: eq(heartbeatRuns.status, 'running'),
  });

  for (const run of runningRuns) {
    const jobId = jobIdFromSnapshot(run.contextSnapshot);
    if (!jobId) continue;

    if (!activeJobIds.has(jobId)) {
      await reconcileRunningRun(jobId, 'stale on worker restart');
      tracer.info('swept stale run on startup', { jobId, runId: run.id });
      continue;
    }

    if (isRunStale(run, cutoff)) {
      await failOverStaleJob(jobId, staleErrorText);
      tracer.info('swept ghost-active stale run on startup', { jobId, runId: run.id });
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
      const { staleSec: sweepStaleSec } = resolveHeartbeatLivenessConfig();
      const sweepCutoff = new Date(Date.now() - sweepStaleSec * 1000);
      const sweepErrorText = heartbeatStaleErrorText(sweepStaleSec);

      const agedRuns = await db
        .select({
          id: heartbeatRuns.id,
          contextSnapshot: heartbeatRuns.contextSnapshot,
          lastSeenAt: heartbeatRuns.lastSeenAt,
          startedAt: heartbeatRuns.startedAt,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.status, 'running'),
            or(
              lt(heartbeatRuns.lastSeenAt, sweepCutoff),
              and(
                sql`${heartbeatRuns.lastSeenAt} IS NULL`,
                lt(heartbeatRuns.startedAt, sweepCutoff),
              ),
            ),
          ),
        );

      for (const run of agedRuns) {
        const jobId = jobIdFromSnapshot(run.contextSnapshot);
        if (!jobId) continue;

        if (!isRunStale(run, sweepCutoff)) continue;

        const job = await heartbeatQueue.getJob(jobId);
        const state = job ? await job.getState() : 'unknown';

        if (state === 'active') {
          await failOverStaleJob(jobId, sweepErrorText);
          continue;
        }

        await reconcileRunningRun(jobId, `periodic sweep: job in state ${state}`);
      }
    })().catch((err) => {
      tracer.error('periodic staleness sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, 60_000);

  tracer.info('started', { queue: QUEUE_HEARTBEAT, staleSec });
}
