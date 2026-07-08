import {
  db,
  agentObservabilityEvents,
  agents,
  heartbeatRuns,
  type AgentObservabilityEvent,
  type HeartbeatRun,
} from '@tourbillon/db';
import { and, count, desc, eq, gte, ilike, inArray, lte, or } from 'drizzle-orm';
import type {
  ListObservabilityEventsInput,
  ListObservabilityEventsResult,
  ObservabilityEventRow,
} from './observability-types';

export type {
  ListObservabilityEventsInput,
  ListObservabilityEventsResult,
  ObservabilityEventRow,
  ObservabilityPageSize,
} from './observability-types';

export {
  OBSERVABILITY_PAGE_SIZES,
  isObservabilityEventStatus,
  isObservabilityEventType,
  isObservabilityPageSize,
} from './observability-types';

type HeartbeatRunSummary = Pick<HeartbeatRun, 'id' | 'status' | 'errorText'>;

function heartbeatRunStatusForRow(
  run: HeartbeatRunSummary | undefined,
): ObservabilityEventRow['heartbeatRunStatus'] {
  if (!run) return null;
  if (run.status === 'running' || run.status === 'succeeded' || run.status === 'failed') {
    return run.status;
  }
  return null;
}

function toRow(
  event: AgentObservabilityEvent,
  agentName: string | null,
  heartbeatRun?: HeartbeatRunSummary,
): ObservabilityEventRow {
  return {
    id: event.id,
    traceId: event.traceId,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    heartbeatRunId: event.heartbeatRunId,
    jobId: event.jobId,
    agentId: event.agentId,
    agentName,
    issueId: event.issueId,
    projectId: event.projectId,
    goalId: event.goalId,
    eventType: event.eventType,
    name: event.name,
    status: event.status,
    model: event.model,
    toolId: event.toolId,
    inputPreview: event.inputPreview,
    outputPreview: event.outputPreview,
    payload: (event.payload as Record<string, unknown> | null) ?? {},
    errorText: event.errorText,
    heartbeatRunStatus: heartbeatRunStatusForRow(heartbeatRun),
    heartbeatRunErrorText: heartbeatRun?.errorText ?? null,
    durationMs: event.durationMs,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    startedAt: event.startedAt?.toISOString() ?? null,
    occurredAt: event.occurredAt.toISOString(),
  };
}

async function loadHeartbeatRunMap(
  runIds: string[],
): Promise<Map<string, HeartbeatRunSummary>> {
  const unique = [...new Set(runIds.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const runs = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      errorText: heartbeatRuns.errorText,
    })
    .from(heartbeatRuns)
    .where(inArray(heartbeatRuns.id, unique));

  return new Map(runs.map((run) => [run.id, run]));
}

export async function listObservabilityEvents(
  input: ListObservabilityEventsInput
): Promise<ListObservabilityEventsResult> {
  const page = input.page ?? 0;
  const pageSize = input.pageSize ?? 25;

  const conditions = [eq(agentObservabilityEvents.companyId, input.companyId)];

  if (input.issueId) conditions.push(eq(agentObservabilityEvents.issueId, input.issueId));
  if (input.projectId) conditions.push(eq(agentObservabilityEvents.projectId, input.projectId));
  if (input.goalId) conditions.push(eq(agentObservabilityEvents.goalId, input.goalId));
  if (input.agentId) conditions.push(eq(agentObservabilityEvents.agentId, input.agentId));
  if (input.eventType) conditions.push(eq(agentObservabilityEvents.eventType, input.eventType));
  if (input.status) conditions.push(eq(agentObservabilityEvents.status, input.status));
  if (input.traceId) conditions.push(eq(agentObservabilityEvents.traceId, input.traceId));
  if (input.heartbeatRunId) {
    conditions.push(eq(agentObservabilityEvents.heartbeatRunId, input.heartbeatRunId));
  }
  if (input.jobId) conditions.push(eq(agentObservabilityEvents.jobId, input.jobId));
  if (input.from) conditions.push(gte(agentObservabilityEvents.occurredAt, input.from));
  if (input.to) conditions.push(lte(agentObservabilityEvents.occurredAt, input.to));

  if (input.search?.trim()) {
    const term = `%${input.search.trim()}%`;
    conditions.push(
      or(
        ilike(agentObservabilityEvents.name, term),
        ilike(agentObservabilityEvents.toolId, term),
        ilike(agentObservabilityEvents.inputPreview, term),
        ilike(agentObservabilityEvents.outputPreview, term),
        ilike(agentObservabilityEvents.traceId, term)
      )!
    );
  }

  const where = and(...conditions);

  const [totalRow] = await db
    .select({ total: count() })
    .from(agentObservabilityEvents)
    .where(where);

  const rows = await db
    .select({
      event: agentObservabilityEvents,
      agentName: agents.name,
    })
    .from(agentObservabilityEvents)
    .leftJoin(agents, eq(agentObservabilityEvents.agentId, agents.id))
    .where(where)
    .orderBy(desc(agentObservabilityEvents.occurredAt))
    .limit(pageSize)
    .offset(page * pageSize);

  const heartbeatRunMap = await loadHeartbeatRunMap(
    rows.map((row) => row.event.heartbeatRunId).filter((id): id is string => Boolean(id)),
  );

  return {
    events: rows.map((row) =>
      toRow(
        row.event,
        row.agentName,
        row.event.heartbeatRunId ? heartbeatRunMap.get(row.event.heartbeatRunId) : undefined,
      ),
    ),
    total: totalRow?.total ?? 0,
    page,
    pageSize,
  };
}

export async function getObservabilityEvent(
  companyId: string,
  eventId: string
): Promise<ObservabilityEventRow | null> {
  const [row] = await db
    .select({
      event: agentObservabilityEvents,
      agentName: agents.name,
    })
    .from(agentObservabilityEvents)
    .leftJoin(agents, eq(agentObservabilityEvents.agentId, agents.id))
    .where(
      and(
        eq(agentObservabilityEvents.companyId, companyId),
        eq(agentObservabilityEvents.id, eventId)
      )
    )
    .limit(1);

  if (!row) return null;

  const heartbeatRunMap = row.event.heartbeatRunId
    ? await loadHeartbeatRunMap([row.event.heartbeatRunId])
    : new Map();

  return toRow(
    row.event,
    row.agentName,
    row.event.heartbeatRunId ? heartbeatRunMap.get(row.event.heartbeatRunId) : undefined,
  );
}
