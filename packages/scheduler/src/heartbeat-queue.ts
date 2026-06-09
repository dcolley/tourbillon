import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { createConnection } from './redis';
import type { HeartbeatJobData } from '@tourbillon/shared';
import { formatTrace, QUEUE_HEARTBEAT } from '@tourbillon/shared';

/**
 * Central heartbeat queue. All agent wakes go through here.
 *
 * Deduplication: jobId = `hb-{agentId}` coalesces pending wakes per agent.
 * If a job with that id is waiting, active, or delayed, new adds are skipped.
 * Completed or failed jobs are removed before re-adding so recurring timer wakes work.
 */
const queueConnection = createConnection();

export const heartbeatQueue = new Queue<HeartbeatJobData>(QUEUE_HEARTBEAT, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
});

export type EnqueueOutcome = 'created' | 'deduplicated' | 'replaced';

export interface EnqueueHeartbeatResult {
  jobId: string;
  outcome: EnqueueOutcome;
}

const PENDING_STATES = new Set(['waiting', 'active', 'delayed']);

export async function enqueueHeartbeat(
  data: HeartbeatJobData,
  opts: { delay?: number; priority?: number; deduplicate?: boolean } = {}
): Promise<EnqueueHeartbeatResult> {
  const { delay = 0, priority, deduplicate = true } = opts;
  const jobId = deduplicate
    ? `hb-${data.agentId}`
    : `hb-${data.agentId}-${randomUUID().slice(0, 8)}`;

  let outcome: EnqueueOutcome = 'created';

  if (deduplicate) {
    const existing = await heartbeatQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (PENDING_STATES.has(state)) {
        console.log(
          formatTrace('enqueue', {
            jobId: existing.id,
            agentId: data.agentId,
            companyId: data.companyId,
            taskId: data.taskId,
            wakeReason: data.wakeReason,
          }, 'heartbeat job deduplicated', {
            deduplicate,
            existingState: state,
            bullJobId: jobId,
          })
        );
        return { jobId: existing.id!, outcome: 'deduplicated' };
      }
      await existing.remove();
      outcome = 'replaced';
    }
  }

  const job = await heartbeatQueue.add(`heartbeat:${data.agentId}`, data, { jobId, delay, priority });

  console.log(
    formatTrace('enqueue', {
      jobId: job.id,
      agentId: data.agentId,
      companyId: data.companyId,
      taskId: data.taskId,
      wakeReason: data.wakeReason,
    }, `heartbeat job ${outcome}`, {
      deduplicate,
      delay,
      priority,
      bullJobId: jobId,
      outcome,
      data,
    })
  );

  return { jobId: job.id!, outcome };
}
