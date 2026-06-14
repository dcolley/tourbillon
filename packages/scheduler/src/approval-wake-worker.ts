import { Worker, type Job } from 'bullmq';
import { createConnection } from './redis';

const workerConnection = createConnection();
import { db, agents } from '@tourbillon/db';
import { and, eq } from 'drizzle-orm';
import { enqueueHeartbeat } from './heartbeat-queue';
import { QUEUE_APPROVAL_WAKES, isHarnessAdapter } from '@tourbillon/shared';
import { getResumableHarnessRun } from '@tourbillon/mastra';
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

    const agentRecord = await db.query.agents.findFirst({
      where: and(eq(agents.id, agentId), eq(agents.companyId, companyId)),
    });

    const taskId = linkedIssueIds?.[0];
    if (agentRecord && isHarnessAdapter(agentRecord.adapterType) && taskId) {
      const resumable = await getResumableHarnessRun(agentId, taskId);
      if (resumable?.finishReason === 'running' || resumable?.harnessRunId) {
        tracer.info('harness suspended run detected — enqueue heartbeat for resume', {
          harnessRunId: resumable.harnessRunId,
        });
      }
    }

    const { jobId: heartbeatJobId } = await enqueueHeartbeat({
      agentId,
      companyId,
      invocationSource: 'approval_resolved',
      wakeReason: 'approval_resolved',
      approvalId,
      approvalStatus: status,
      linkedIssueIds,
      taskId,
    }, { deduplicate: false, priority: 1 });

    tracer.info('heartbeat enqueued from approval wake', { heartbeatJobId });
  },
  { connection: workerConnection, concurrency: 10 }
);
