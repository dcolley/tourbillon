import type { Job, JobType } from 'bullmq';
import type { HeartbeatJobData } from '@tourbillon/shared';
import { QUEUE_HEARTBEAT } from '@tourbillon/shared';
import { getQueue, JOB_QUEUES, isJobQueueName, connection, type JobQueueName } from './queue';
import { getHeartbeatRunByJobId, getHeartbeatTaskId } from './heartbeats';

export type JobState = 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused';

export const JOB_STATES: JobState[] = ['waiting', 'active', 'completed', 'failed', 'delayed'];

export interface QueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

export interface QueueOverviewItem {
  name: JobQueueName;
  label: string;
  description: string;
  counts: QueueCounts;
}

export interface JobSummary {
  id: string;
  name: string;
  state: string;
  timestamp: number | null;
  processedOn: number | null;
  finishedOn: number | null;
  attemptsMade: number;
}

export interface JobDetail {
  id: string;
  name: string;
  state: string;
  timestamp: number | null;
  processedOn: number | null;
  finishedOn: number | null;
  attemptsMade: number;
  failedReason: string | null;
  stacktrace: string[];
  data: unknown;
  returnvalue: unknown;
  opts: unknown;
  logs: string[];
  logCount: number;
}

export interface JobLogs {
  logs: string[];
  count: number;
  state: string;
}

export interface JobLiveSnapshot extends JobLogs {
  attemptsMade: number;
  timestamp: number | null;
  processedOn: number | null;
  finishedOn: number | null;
  heartbeatRun: HeartbeatRunSnapshot | null;
}

export interface HeartbeatRunSnapshot {
  id: string;
  status: string;
  invocationSource: string;
  startedAt: string;
  finishedAt: string | null;
  errorText: string | null;
  contextSnapshot: unknown;
  taskId: string | null;
  agent: { id: string; name: string; urlKey: string; title: string } | null;
}

export class JobsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobsError';
  }
}

export function getQueueMeta(name: string) {
  if (!isJobQueueName(name)) return null;
  return JOB_QUEUES.find((q) => q.name === name) ?? null;
}

export async function pingRedis(): Promise<boolean> {
  try {
    await connection.ping();
    return true;
  } catch {
    return false;
  }
}

function emptyCounts(): QueueCounts {
  return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 };
}

export async function getQueueOverview(): Promise<{ queues: QueueOverviewItem[]; redisOk: boolean }> {
  const redisOk = await pingRedis();
  if (!redisOk) {
    return {
      redisOk: false,
      queues: JOB_QUEUES.map((q) => ({ ...q, counts: emptyCounts() })),
    };
  }

  const queues = await Promise.all(
    JOB_QUEUES.map(async (meta) => {
      const counts = await getQueue(meta.name).getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
        'paused'
      );
      return {
        ...meta,
        counts: {
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          completed: counts.completed ?? 0,
          failed: counts.failed ?? 0,
          delayed: counts.delayed ?? 0,
          paused: counts.paused ?? 0,
        },
      };
    })
  );

  return { redisOk: true, queues };
}

async function toJobSummary(job: Job): Promise<JobSummary> {
  return {
    id: job.id ?? '',
    name: job.name,
    state: await job.getState(),
    timestamp: job.timestamp ?? null,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
    attemptsMade: job.attemptsMade,
  };
}

export async function getQueueJobs(
  queueName: JobQueueName,
  state: JobState,
  page = 0,
  pageSize = 50
): Promise<{ jobs: JobSummary[]; total: number }> {
  if (!isJobQueueName(queueName)) throw new JobsError('Unknown queue.');

  const start = page * pageSize;
  const end = start + pageSize - 1;
  const jobs = await getQueue(queueName).getJobs([state as JobType], start, end, false);

  return {
    jobs: await Promise.all(jobs.filter(Boolean).map(toJobSummary)),
    total: await getQueue(queueName).getJobCountByTypes(state as JobType),
  };
}

export async function getJobLogs(
  queueName: JobQueueName,
  jobId: string
): Promise<JobLogs | null> {
  const snapshot = await getJobLiveSnapshot(queueName, jobId);
  if (!snapshot) return null;
  return {
    logs: snapshot.logs,
    count: snapshot.count,
    state: snapshot.state,
  };
}

export async function getJobLiveSnapshot(
  queueName: JobQueueName,
  jobId: string,
): Promise<JobLiveSnapshot | null> {
  if (!isJobQueueName(queueName)) throw new JobsError('Unknown queue.');

  const job = await getQueue(queueName).getJob(jobId);
  if (!job) return null;

  const [{ logs, count }, state, heartbeatRun] = await Promise.all([
    getQueue(queueName).getJobLogs(jobId),
    job.getState(),
    queueName === QUEUE_HEARTBEAT ? getHeartbeatRunByJobId(jobId) : Promise.resolve(null),
  ]);

  return {
    logs,
    count,
    state,
    attemptsMade: job.attemptsMade,
    timestamp: job.timestamp ?? null,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
    heartbeatRun: heartbeatRun
      ? {
          id: heartbeatRun.run.id,
          status: heartbeatRun.run.status,
          invocationSource: heartbeatRun.run.invocationSource,
          startedAt: heartbeatRun.run.startedAt.toISOString(),
          finishedAt: heartbeatRun.run.finishedAt?.toISOString() ?? null,
          errorText: heartbeatRun.run.errorText,
          contextSnapshot: heartbeatRun.run.contextSnapshot,
          taskId: getHeartbeatTaskId(heartbeatRun.run) ?? null,
          agent: heartbeatRun.agent,
        }
      : null,
  };
}

export async function getJobDetail(queueName: JobQueueName, jobId: string): Promise<JobDetail | null> {
  if (!isJobQueueName(queueName)) throw new JobsError('Unknown queue.');

  const job = await getQueue(queueName).getJob(jobId);
  if (!job) return null;

  const [state, { logs, count }] = await Promise.all([
    job.getState(),
    getQueue(queueName).getJobLogs(jobId),
  ]);

  return {
    id: job.id ?? '',
    name: job.name,
    state,
    timestamp: job.timestamp ?? null,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason ?? null,
    stacktrace: job.stacktrace ?? [],
    data: job.data,
    returnvalue: job.returnvalue,
    opts: job.opts,
    logs,
    logCount: count,
  };
}

export async function retryJob(queueName: JobQueueName, jobId: string): Promise<void> {
  const job = await getQueue(queueName).getJob(jobId);
  if (!job) throw new JobsError('Job not found.');
  const state = await job.getState();
  if (state !== 'failed') throw new JobsError('Only failed jobs can be retried.');
  await job.retry();
}

export async function removeJob(queueName: JobQueueName, jobId: string): Promise<void> {
  const job = await getQueue(queueName).getJob(jobId);
  if (!job) throw new JobsError('Job not found.');
  await job.remove();
}

const HEARTBEAT_JOB_STATES: JobType[] = ['active', 'waiting', 'completed', 'failed', 'delayed'];

export async function findHeartbeatJobsForTask(taskId: string): Promise<JobSummary[]> {
  const queue = getQueue(QUEUE_HEARTBEAT);
  const batches = await Promise.all(
    HEARTBEAT_JOB_STATES.map((state) => queue.getJobs([state], 0, 100, false))
  );

  const matching = batches
    .flat()
    .filter((job): job is Job<HeartbeatJobData> => Boolean(job))
    .filter((job) => job.data?.taskId === taskId);

  return Promise.all(matching.map(toJobSummary));
}
