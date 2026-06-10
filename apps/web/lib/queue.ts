/**
 * BullMQ queue clients for the web app (Next.js API routes + server actions).
 * Kept local to avoid importing @tourbillon/scheduler (which starts workers).
 */
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import IORedis from 'ioredis';
import type { HeartbeatJobData } from '@tourbillon/shared';
import { formatTrace, QUEUE_HEARTBEAT, QUEUE_APPROVAL_WAKES } from '@tourbillon/shared';
import { enrichHeartbeatJob } from './wake-payload';

export type JobQueueName = typeof QUEUE_HEARTBEAT | typeof QUEUE_APPROVAL_WAKES;

export const JOB_QUEUES: Array<{ name: JobQueueName; label: string; description: string }> = [
  {
    name: QUEUE_HEARTBEAT,
    label: 'Heartbeat',
    description: 'Agent wake jobs — on-demand, assignment, timer, and approval triggers',
  },
  {
    name: QUEUE_APPROVAL_WAKES,
    label: 'Approval wakes',
    description: 'Relay board decisions into heartbeat jobs for requesting agents',
  },
];

export const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

const queues = new Map<string, Queue>();

export function getQueue(name: JobQueueName): Queue {
  const existing = queues.get(name);
  if (existing) return existing;

  const queue =
    name === QUEUE_HEARTBEAT
      ? new Queue<HeartbeatJobData>(QUEUE_HEARTBEAT, {
          connection,
          defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: { count: 500 },
            removeOnFail: { count: 200 },
          },
        })
      : new Queue(QUEUE_APPROVAL_WAKES, { connection });

  queues.set(name, queue);
  return queue;
}

export function isJobQueueName(name: string): name is JobQueueName {
  return JOB_QUEUES.some((q) => q.name === name);
}

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

  const queue = getQueue(QUEUE_HEARTBEAT);
  let outcome: EnqueueOutcome = 'created';

  if (deduplicate) {
    const existing = await queue.getJob(jobId);
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
          }, 'heartbeat job deduplicated from web', {
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

  const enriched = await enrichHeartbeatJob(data);
  const job = await queue.add(`heartbeat:${enriched.agentId}`, enriched, { jobId, delay, priority });

  console.log(
    formatTrace('enqueue', {
      jobId: job.id,
      agentId: data.agentId,
      companyId: data.companyId,
      taskId: data.taskId,
      wakeReason: data.wakeReason,
    }, `heartbeat job ${outcome} from web`, {
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

export async function enqueueApprovalWake(data: {
  approvalId: string;
  agentId: string;
  companyId: string;
  status: 'approved' | 'rejected';
  linkedIssueIds?: string[];
}): Promise<void> {
  await getQueue(QUEUE_APPROVAL_WAKES).add('approval-wake', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });
}
