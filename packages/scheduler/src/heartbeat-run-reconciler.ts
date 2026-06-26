import { QueueEvents } from 'bullmq';
import { createTraceLogger, QUEUE_HEARTBEAT } from '@tourbillon/shared';
import { reconcileRunningHeartbeatRunsForJob } from '@tourbillon/db';
import { createConnection } from './redis';

const tracer = createTraceLogger('heartbeat-reconciler', {});

async function reconcileRunningRun(jobId: string, errorText: string): Promise<void> {
  const runIds = await reconcileRunningHeartbeatRunsForJob(jobId, errorText);
  if (runIds.length > 0) {
    tracer.info('reconciled stale heartbeat run', { jobId, runIds, errorText });
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

  tracer.info('started', { queue: QUEUE_HEARTBEAT });
}
