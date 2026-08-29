import { db, agents, heartbeatRuns, llmProviders, type Agent, type HeartbeatRun } from '@tourbillon/db';
import { desc, eq, and, inArray, count } from 'drizzle-orm';
import { getActiveCompany } from './company';

export interface HeartbeatAgentSummary {
  id: string;
  name: string;
  urlKey: string;
  title: string;
  modelId: string | null;
  providerName: string | null;
}

export interface HeartbeatRunWithAgent {
  run: HeartbeatRun;
  agent: HeartbeatAgentSummary | null;
}

export type { HeartbeatListFilter } from './heartbeat-list-storage';
export { HEARTBEAT_LIST_FILTERS } from './heartbeat-list-storage';

import type { HeartbeatListFilter } from './heartbeat-list-storage';

export interface HeartbeatListEntry {
  key: string;
  runId: string | null;
  jobId: string | null;
  agent: Pick<Agent, 'id' | 'name' | 'urlKey' | 'title'> | null;
  providerName: string | null;
  modelId: string | null;
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

async function attachAgents(runs: HeartbeatRun[]): Promise<HeartbeatRunWithAgent[]> {
  if (runs.length === 0) return [];

  const company = await getActiveCompany();
  const agentIds = [...new Set(runs.map((r) => r.agentId))];
  const agentRows = await db
    .select({
      id: agents.id,
      name: agents.name,
      urlKey: agents.urlKey,
      title: agents.title,
      modelId: agents.modelId,
      providerName: llmProviders.name,
    })
    .from(agents)
    .leftJoin(llmProviders, eq(agents.providerId, llmProviders.id))
    .where(and(eq(agents.companyId, company.id), inArray(agents.id, agentIds)));

  const agentById = new Map(
    agentRows.map((a) => [
      a.id,
      {
        id: a.id,
        name: a.name,
        urlKey: a.urlKey,
        title: a.title,
        modelId: a.modelId ?? null,
        providerName: a.providerName ?? null,
      },
    ]),
  );

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
  const company = await getActiveCompany();

  const runs = await db
    .select()
    .from(heartbeatRuns)
    .where(
      agentId
        ? and(eq(heartbeatRuns.companyId, company.id), eq(heartbeatRuns.agentId, agentId))
        : eq(heartbeatRuns.companyId, company.id),
    )
    .orderBy(desc(heartbeatRuns.startedAt))
    .limit(limit);

  return attachAgents(runs);
}

async function countHeartbeatRuns(
  companyId: string,
  filter: HeartbeatListFilter,
  agentId?: string,
): Promise<number> {
  const statusCond = runStatusCondition(filter);
  const where = and(
    eq(heartbeatRuns.companyId, companyId),
    agentId ? eq(heartbeatRuns.agentId, agentId) : undefined,
    statusCond,
  );

  const [row] = await db.select({ total: count() }).from(heartbeatRuns).where(where);
  return row?.total ?? 0;
}

function snapshotString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function inferenceFromRun(
  run: HeartbeatRun,
  agent: HeartbeatAgentSummary | null,
): { providerName: string | null; modelId: string | null } {
  const snapshot = run.contextSnapshot as { providerName?: unknown; modelId?: unknown } | null;
  return {
    providerName: snapshotString(snapshot?.providerName) ?? agent?.providerName ?? null,
    modelId: snapshotString(snapshot?.modelId) ?? agent?.modelId ?? null,
  };
}

function entryFromRun({ run, agent }: HeartbeatRunWithAgent): HeartbeatListEntry {
  const inference = inferenceFromRun(run, agent);
  return {
    key: run.id,
    runId: run.id,
    jobId: null,
    agent,
    providerName: inference.providerName,
    modelId: inference.modelId,
    invocationSource: run.invocationSource,
    runStatus: run.status,
    jobState: null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    errorText: run.errorText,
    href: `/heartbeat/${run.id}`,
    source: 'db',
  };
}

export async function getHeartbeatList(opts: {
  filter?: HeartbeatListFilter;
  page?: number;
  pageSize?: number;
  agentId?: string;
  companyId?: string;
} = {}): Promise<HeartbeatListResult> {
  const filter = opts.filter === 'in_queue' ? 'running' : (opts.filter ?? 'all');
  const page = Math.max(0, opts.page ?? 0);
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const company = opts.companyId 
    ? { id: opts.companyId }
    : await getActiveCompany();

  const statusCond = runStatusCondition(filter);
  const where = and(
    eq(heartbeatRuns.companyId, company.id),
    opts.agentId ? eq(heartbeatRuns.agentId, opts.agentId) : undefined,
    statusCond,
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
  const entries = withAgents.map((item) => entryFromRun(item));

  return { entries, total: dbTotal, page, pageSize, filter };
}

export async function getHeartbeatRun(runId: string): Promise<HeartbeatRunWithAgent | null> {
  const run = await db.query.heartbeatRuns.findFirst({
    where: eq(heartbeatRuns.id, runId),
  });
  if (!run) return null;

  const [agent] = await db
    .select({
      id: agents.id,
      name: agents.name,
      urlKey: agents.urlKey,
      title: agents.title,
      modelId: agents.modelId,
      providerName: llmProviders.name,
    })
    .from(agents)
    .leftJoin(llmProviders, eq(agents.providerId, llmProviders.id))
    .where(eq(agents.id, run.agentId))
    .limit(1);

  return {
    run,
    agent: agent
      ? {
          ...agent,
          modelId: agent.modelId ?? null,
          providerName: agent.providerName ?? null,
        }
      : null,
  };
}

export function getHeartbeatJobId(_run: HeartbeatRun): string | undefined {
  return undefined;
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

export function heartbeatJobHref(run: HeartbeatRun): string | null {
  return `/heartbeat/${run.id}`;
}

/** Latest queued or running heartbeat for an agent, if any. */
export async function getInFlightHeartbeatRun(
  agentId: string,
): Promise<{ id: string; status: 'queued' | 'running' } | null> {
  const [run] = await db
    .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.agentId, agentId),
        inArray(heartbeatRuns.status, ['queued', 'running']),
      ),
    )
    .orderBy(desc(heartbeatRuns.startedAt))
    .limit(1);

  if (!run) return null;
  if (run.status !== 'queued' && run.status !== 'running') return null;
  return { id: run.id, status: run.status };
}

export async function getHeartbeatRunByJobId(_jobId: string): Promise<HeartbeatRunWithAgent | null> {
  return null;
}
