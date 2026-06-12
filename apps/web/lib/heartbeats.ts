import { db, agents, heartbeatRuns, type Agent, type HeartbeatRun } from '@tourbillon/db';
import { desc, eq, and, inArray, sql, count } from 'drizzle-orm';
import type { JobType } from 'bullmq';
import { QUEUE_HEARTBEAT } from '@tourbillon/shared';
import { getOrCreateDefaultCompany } from './company';
import { getQueue } from './queue';
import type { JobSummary } from './jobs';

export interface HeartbeatRunWithAgent {
  run: HeartbeatRun;
  agent: Pick<Agent, 'id' | 'name' | 'urlKey' | 'title'> | null;
}

export type { HeartbeatListFilter } from './heartbeat-list-storage';
export { HEARTBEAT_LIST_FILTERS } from './heartbeat-list-storage';

import type { HeartbeatListFilter } from './heartbeat-list-storage';

export interface HeartbeatListEntry {
  key: string;
  runId: string | null;
  jobId: string | null;
  agent: Pick<Agent, 'id' | 'name' | 'urlKey' | 'title'> | null;
  invocationSource: string | null;
  runStatus: string | null;
  jobState: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorText: string | null;
  href: string;
  source: 'db' | 'queue';
}

export interface HeartbeatListResult {
  entries: HeartbeatListEntry[];
  total: number;
  page: number;
  pageSize: number;
  filter: HeartbeatListFilter;
}

const IN_QUEUE_JOB_STATES: JobType[] = ['waiting', 'active', 'delayed'];
const DEFAULT_PAGE_SIZE = 25;

function runStatusCondition(filter: HeartbeatListFilter) {
  switch (filter) {
    case 'running':
      return eq(heartbeatRuns.status, 'running');
    case 'succeeded':
      return eq(heartbeatRuns.status, 'succeeded');
    case 'failed':
      return eq(heartbeatRuns.status, 'failed');
    case 'queued':
      return eq(heartbeatRuns.status, 'queued');
    default:
      return undefined;
  }
}

async function attachAgents(
  runs: HeartbeatRun[]
): Promise<HeartbeatRunWithAgent[]> {
  if (runs.length === 0) return [];

  const company = await getOrCreateDefaultCompany();
  const agentIds = [...new Set(runs.map((r) => r.agentId))];
  const agentRows = await db
    .select({ id: agents.id, name: agents.name, urlKey: agents.urlKey, title: agents.title })
    .from(agents)
    .where(and(eq(agents.companyId, company.id), inArray(agents.id, agentIds)));

  const agentById = new Map(agentRows.map((a) => [a.id, a]));

  return runs.map((run) => ({
    run,
    agent: agentById.get(run.agentId) ?? null,
  }));
}

export async function listHeartbeatRuns(opts: {
  agentId?: string;
  limit?: number;
} = {}): Promise<HeartbeatRunWithAgent[]> {
  const { agentId, limit = 50 } = opts;
  const company = await getOrCreateDefaultCompany();

  const runs = await db
    .select()
    .from(heartbeatRuns)
    .where(
      agentId
        ? and(eq(heartbeatRuns.companyId, company.id), eq(heartbeatRuns.agentId, agentId))
        : eq(heartbeatRuns.companyId, company.id)
    )
    .orderBy(desc(heartbeatRuns.startedAt))
    .limit(limit);

  return attachAgents(runs);
}

async function countHeartbeatRuns(
  companyId: string,
  filter: HeartbeatListFilter,
  agentId?: string
): Promise<number> {
  const statusCond = runStatusCondition(filter);
  const where = and(
    eq(heartbeatRuns.companyId, companyId),
    agentId ? eq(heartbeatRuns.agentId, agentId) : undefined,
    statusCond
  );

  const [row] = await db.select({ total: count() }).from(heartbeatRuns).where(where);
  return row?.total ?? 0;
}

async function fetchJobsById(jobIds: string[]): Promise<Map<string, JobSummary>> {
  const unique = [...new Set(jobIds.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const queue = getQueue(QUEUE_HEARTBEAT);
  const jobs = await Promise.all(unique.map((id) => queue.getJob(id)));
  const map = new Map<string, JobSummary>();

  for (const job of jobs) {
    if (!job?.id) continue;
    map.set(job.id, {
      id: job.id,
      name: job.name,
      state: await job.getState(),
      timestamp: job.timestamp ?? null,
      processedOn: job.processedOn ?? null,
      finishedOn: job.finishedOn ?? null,
      attemptsMade: job.attemptsMade,
    });
  }

  return map;
}

function entryFromRun(
  { run, agent }: HeartbeatRunWithAgent,
  job?: JobSummary
): HeartbeatListEntry {
  const jobId = getHeartbeatJobId(run) ?? job?.id ?? null;
  const listState = job?.state ?? heartbeatJobListState(run);
  const href = jobId
    ? `/jobs/${QUEUE_HEARTBEAT}/${encodeURIComponent(jobId)}?state=${listState}`
    : `/heartbeat/${run.id}`;

  return {
    key: run.id,
    runId: run.id,
    jobId,
    agent,
    invocationSource: run.invocationSource,
    runStatus: run.status,
    jobState: job?.state ?? null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    errorText: run.errorText,
    href,
    source: 'db',
  };
}

function entryFromOrphanJob(
  job: JobSummary,
  meta: { wakeReason?: string } | undefined,
  agent?: Pick<Agent, 'id' | 'name' | 'urlKey' | 'title'> | null
): HeartbeatListEntry {
  return {
    key: `job:${job.id}`,
    runId: null,
    jobId: job.id,
    agent: agent ?? null,
    invocationSource: meta?.wakeReason ?? null,
    runStatus: null,
    jobState: job.state,
    startedAt: job.timestamp ? new Date(job.timestamp) : null,
    finishedAt: job.finishedOn ? new Date(job.finishedOn) : null,
    errorText: null,
    href: `/jobs/${QUEUE_HEARTBEAT}/${encodeURIComponent(job.id)}?state=${job.state}`,
    source: 'queue',
  };
}

async function listOrphanQueueJobs(agentId?: string): Promise<HeartbeatListEntry[]> {
  const queue = getQueue(QUEUE_HEARTBEAT);
  const batches = await Promise.all(
    IN_QUEUE_JOB_STATES.map((state) => queue.getJobs([state], 0, 100, false))
  );

  const jobs = batches.flat().filter(Boolean);
  if (jobs.length === 0) return [];

  const summaries = await Promise.all(
    jobs.map(async (job) => ({
      summary: {
        id: job!.id ?? '',
        name: job!.name,
        state: await job!.getState(),
        timestamp: job!.timestamp ?? null,
        processedOn: job!.processedOn ?? null,
        finishedOn: job!.finishedOn ?? null,
        attemptsMade: job!.attemptsMade,
      } satisfies JobSummary,
      data: job!.data as { agentId?: string; wakeReason?: string },
    }))
  );

  const jobIds = summaries.map((j) => j.summary.id).filter(Boolean);
  const company = await getOrCreateDefaultCompany();

  const runsWithJobs =
    jobIds.length > 0
      ? await db
          .select({ jobId: sql<string>`${heartbeatRuns.contextSnapshot}->>'jobId'` })
          .from(heartbeatRuns)
          .where(
            sql`${heartbeatRuns.contextSnapshot}->>'jobId' = ANY(ARRAY[${sql.join(
              jobIds.map((id) => sql`${id}`),
              sql`, `
            )}]::text[])`
          )
      : [];

  const linkedJobIds = new Set(runsWithJobs.map((r) => r.jobId).filter(Boolean));
  const orphans = summaries.filter((j) => j.summary.id && !linkedJobIds.has(j.summary.id));

  if (orphans.length === 0) return [];

  const agentIds = [
    ...new Set(orphans.map((j) => j.data.agentId).filter((id): id is string => Boolean(id))),
  ];

  const agentRows =
    agentIds.length > 0
      ? await db
          .select({ id: agents.id, name: agents.name, urlKey: agents.urlKey, title: agents.title })
          .from(agents)
          .where(and(eq(agents.companyId, company.id), inArray(agents.id, agentIds)))
      : [];

  const agentById = new Map(agentRows.map((a) => [a.id, a]));

  return orphans
    .filter((j) => !agentId || j.data.agentId === agentId)
    .map((j) =>
      entryFromOrphanJob(
        j.summary,
        { wakeReason: j.data.wakeReason },
        j.data.agentId ? agentById.get(j.data.agentId) ?? null : null
      )
    )
    .sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0));
}

export async function getHeartbeatList(opts: {
  filter?: HeartbeatListFilter;
  page?: number;
  pageSize?: number;
  agentId?: string;
} = {}): Promise<HeartbeatListResult> {
  const filter = opts.filter ?? 'all';
  const page = Math.max(0, opts.page ?? 0);
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const company = await getOrCreateDefaultCompany();

  if (filter === 'in_queue') {
    const orphans = await listOrphanQueueJobs(opts.agentId);
    const total = orphans.length;
    const start = page * pageSize;
    return {
      entries: orphans.slice(start, start + pageSize),
      total,
      page,
      pageSize,
      filter,
    };
  }

  const statusCond = runStatusCondition(filter);
  const where = and(
    eq(heartbeatRuns.companyId, company.id),
    opts.agentId ? eq(heartbeatRuns.agentId, opts.agentId) : undefined,
    statusCond
  );

  const [runs, dbTotal] = await Promise.all([
    db
      .select()
      .from(heartbeatRuns)
      .where(where)
      .orderBy(desc(heartbeatRuns.startedAt))
      .limit(pageSize)
      .offset(page * pageSize),
    countHeartbeatRuns(company.id, filter, opts.agentId),
  ]);

  const withAgents = await attachAgents(runs);
  const jobIds = withAgents.map(({ run }) => getHeartbeatJobId(run)).filter((id): id is string => Boolean(id));
  const jobsById = await fetchJobsById(jobIds);

  const entries = withAgents.map((item) => {
    const jobId = getHeartbeatJobId(item.run);
    return entryFromRun(item, jobId ? jobsById.get(jobId) : undefined);
  });

  return { entries, total: dbTotal, page, pageSize, filter };
}

export async function getHeartbeatRun(runId: string): Promise<HeartbeatRunWithAgent | null> {
  const run = await db.query.heartbeatRuns.findFirst({
    where: eq(heartbeatRuns.id, runId),
  });
  if (!run) return null;

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, run.agentId),
    columns: { id: true, name: true, urlKey: true, title: true },
  });

  return { run, agent: agent ?? null };
}

export function getHeartbeatJobId(run: HeartbeatRun): string | undefined {
  const snapshot = run.contextSnapshot as { jobId?: string } | null;
  return snapshot?.jobId;
}

export function getHeartbeatTaskId(run: HeartbeatRun): string | undefined {
  const snapshot = run.contextSnapshot as { taskId?: string } | null;
  return snapshot?.taskId;
}

export function heartbeatJobListState(run: HeartbeatRun): string {
  if (run.status === 'running') return 'active';
  if (run.status === 'failed') return 'failed';
  return 'completed';
}

/** Canonical URL for a heartbeat run — nested under /jobs/heartbeat/{jobId}. */
export function heartbeatJobHref(run: HeartbeatRun): string | null {
  const jobId = getHeartbeatJobId(run);
  if (!jobId) return null;
  return `/jobs/${QUEUE_HEARTBEAT}/${encodeURIComponent(jobId)}?state=${heartbeatJobListState(run)}`;
}

export async function getHeartbeatRunByJobId(jobId: string): Promise<HeartbeatRunWithAgent | null> {
  const [run] = await db
    .select()
    .from(heartbeatRuns)
    .where(sql`${heartbeatRuns.contextSnapshot}->>'jobId' = ${jobId}`)
    .orderBy(desc(heartbeatRuns.startedAt))
    .limit(1);
  if (!run) return null;

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, run.agentId),
    columns: { id: true, name: true, urlKey: true, title: true },
  });

  return { run, agent: agent ?? null };
}
