import { db, heartbeatRuns } from '@tourbillon/db';
import { desc, eq, sql } from 'drizzle-orm';
import { getActiveCompanyOrNull } from './company';
import { getHeartbeatRun, getHeartbeatTaskId } from './heartbeats';

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
  name: string;
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
  lastSeenAt: string | null;
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

function emptyCounts(): QueueCounts {
  return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 };
}

export function getQueueMeta(name: string) {
  if (name === 'heartbeat') {
    return {
      name: 'heartbeat',
      label: 'Heartbeat runs',
      description: 'Agent wakes (DB heartbeat_runs — no BullMQ)',
    };
  }
  return null;
}

export async function getQueueOverview(): Promise<{ queues: QueueOverviewItem[]; redisOk: boolean }> {
  const company = await getActiveCompanyOrNull();
  const counts = emptyCounts();
  if (company) {
    const runs = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, company.id));
    for (const row of runs) {
      if (row.status === 'running') counts.active += 1;
      else if (row.status === 'failed') counts.failed += 1;
      else if (row.status === 'succeeded') counts.completed += 1;
      else if (row.status === 'queued') counts.waiting += 1;
    }
  }

  return {
    redisOk: true,
    queues: [
      {
        name: 'heartbeat',
        label: 'Heartbeat runs',
        description: 'Agent wakes tracked in heartbeat_runs (WakeRunner — no BullMQ)',
        counts,
      },
    ],
  };
}

export async function getQueueJobs(
  _queueName: string,
  _state: string,
  _page = 0,
  _pageSize = 50,
): Promise<{ jobs: JobSummary[]; total: number }> {
  return { jobs: [], total: 0 };
}

export async function getJobDetail(_queueName: string, jobId: string): Promise<JobDetail | null> {
  const linked = await getHeartbeatRun(jobId);
  if (!linked) return null;
  const { run, agent } = linked;
  return {
    id: run.id,
    name: `wake:${agent?.name ?? run.agentId}`,
    state: run.status === 'running' ? 'active' : run.status === 'failed' ? 'failed' : 'completed',
    timestamp: run.startedAt.getTime(),
    processedOn: run.startedAt.getTime(),
    finishedOn: run.finishedAt?.getTime() ?? null,
    attemptsMade: 1,
    failedReason: run.errorText,
    stacktrace: [],
    data: run.contextSnapshot,
    returnvalue: null,
    opts: {},
    logs: [],
    logCount: 0,
  };
}

export async function getJobLiveSnapshot(
  _queueName: string,
  jobId: string,
): Promise<JobLiveSnapshot | null> {
  const linked = await getHeartbeatRun(jobId);
  if (!linked) return null;
  const { run, agent } = linked;
  return {
    logs: [],
    count: 0,
    state: run.status === 'running' ? 'active' : run.status === 'failed' ? 'failed' : 'completed',
    attemptsMade: 1,
    timestamp: run.startedAt.getTime(),
    processedOn: run.startedAt.getTime(),
    finishedOn: run.finishedAt?.getTime() ?? null,
    heartbeatRun: {
      id: run.id,
      status: run.status,
      invocationSource: run.invocationSource,
      startedAt: run.startedAt.toISOString(),
      lastSeenAt: run.lastSeenAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      errorText: run.errorText,
      contextSnapshot: run.contextSnapshot,
      taskId: getHeartbeatTaskId(run) ?? null,
      agent: agent
        ? { id: agent.id, name: agent.name, urlKey: agent.urlKey, title: agent.title }
        : null,
    },
  };
}

export async function getJobLogs(
  queueName: string,
  jobId: string,
): Promise<JobLogs | null> {
  const snapshot = await getJobLiveSnapshot(queueName, jobId);
  if (!snapshot) return null;
  return {
    logs: snapshot.logs,
    count: snapshot.count,
    state: snapshot.state,
  };
}

export async function retryJob(_queueName: string, _jobId: string): Promise<void> {
  throw new JobsError('BullMQ jobs removed — re-trigger a wake from the agent page.');
}

export async function removeJob(_queueName: string, _jobId: string): Promise<void> {
  throw new JobsError('BullMQ jobs removed.');
}

export async function findHeartbeatJobsForTask(taskId: string): Promise<JobSummary[]> {
  const runs = await db
    .select()
    .from(heartbeatRuns)
    .where(sql`${heartbeatRuns.contextSnapshot}->>'taskId' = ${taskId}`)
    .orderBy(desc(heartbeatRuns.startedAt))
    .limit(20);

  return runs.map((run) => ({
    id: run.id,
    name: `wake:${run.agentId}`,
    state: run.status === 'running' ? 'active' : run.status === 'failed' ? 'failed' : 'completed',
    timestamp: run.startedAt.getTime(),
    processedOn: run.startedAt.getTime(),
    finishedOn: run.finishedAt?.getTime() ?? null,
    attemptsMade: 1,
  }));
}
