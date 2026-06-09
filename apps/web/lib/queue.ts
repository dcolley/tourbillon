/**
 * Queue client for the web app (Next.js API routes).
 * Imports heartbeat-queue from the scheduler package.
 */
import { enqueueHeartbeat as _enqueueHeartbeat } from '@paperclip-mastra/scheduler';
export { _enqueueHeartbeat as enqueueHeartbeat };

import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { QUEUE_APPROVAL_WAKES } from '@paperclip-mastra/shared';

const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

const approvalWakeQueue = new Queue(QUEUE_APPROVAL_WAKES, { connection });

export async function enqueueApprovalWake(data: {
  approvalId: string;
  agentId: string;
  companyId: string;
  status: 'approved' | 'rejected';
  linkedIssueIds?: string[];
}): Promise<void> {
  await approvalWakeQueue.add('approval-wake', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });
}
