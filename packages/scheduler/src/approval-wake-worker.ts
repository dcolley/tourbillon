import { Worker, type Job } from 'bullmq';
import { createConnection } from './redis';

const workerConnection = createConnection();
import { enqueueHeartbeat } from './heartbeat-queue';
import { QUEUE_APPROVAL_WAKES } from '@tourbillon/shared';
import { createJobTracer } from './job-trace';

interface ApprovalWakeJobData {
  approvalId: string;
  agentId: string;
  companyId: string;
  status: 'approved' | 'rejected';
  linkedIssueIds?: string[];
}

export const approvalWakeWorker = new Worker<ApprovalWakeJobData>(
  QUEUE_APPROVAL_WAKES,
  async (job: Job<ApprovalWakeJobData>) => {
    const { approvalId, agentId, status, companyId, linkedIssueIds } = job.data;
    const tracer = createJobTracer('approval-wake', { jobId: job.id, agentId, companyId }, job);
    tracer.info('processing approval wake', { approvalId, status, linkedIssueIds });

    const { jobId: heartbeatJobId } = await enqueueHeartbeat({
      agentId,
      companyId,
      invocationSource: 'approval_resolved',
      wakeReason: 'approval_resolved',
      approvalId,
      approvalStatus: status,
      linkedIssueIds,
    }, { deduplicate: false, priority: 1 });

    tracer.info('heartbeat enqueued from approval wake', { heartbeatJobId });
  },
  { connection: workerConnection, concurrency: 10 }
);
