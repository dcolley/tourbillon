import { QueueEvents } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { db, heartbeatRuns } from '@tourbillon/db';
import { createTraceLogger, QUEUE_HEARTBEAT } from '@tourbillon/shared';
import { createConnection } from './redis';

const tracer = createTraceLogger('heartbeat-reconciler', {});

async function reconcileRunningRun(jobId: string, errorText: string): Promise<void> {
  const updated = await db
    .update(heartbeatRuns)
    .set({
      status: 'failed',
      errorText,
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(heartbeatRuns.status, 'running'),
        sql`context_snapshot->>'jobId' = ${jobId}`,
      ),
    )
    .returning({ id: heartbeatRuns.id });

  if (updated.length > 0) {
    tracer.info('reconciled stale heartbeat run', {
      jobId,
      runIds: updated.map((row) => row.id),
      errorText,
    });
  }
}

export function startReconciler(): void {
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
    void reconcileRunningRun(jobId, 'BullMQ job stalled').catch((err) => {
      tracer.error('failed to reconcile failed job', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  tracer.info('started', { queue: QUEUE_HEARTBEAT });
}
