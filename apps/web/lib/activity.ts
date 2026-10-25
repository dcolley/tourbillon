/**
 * ACT-1: company-scoped activity reads for the Control Pane Activity page and the per-issue feed.
 * Every query is filtered on `company_id`, including the name lookup for linked items, so a row can
 * never show the name of (or link to) another company's issue, agent, run, approval, project or goal.
 */
import {
  db,
  activityLog,
  agents,
  approvals,
  goals,
  heartbeatRuns,
  issues,
  projects,
  type ActivityLogEntry,
} from '@tourbillon/db';
import { and, asc, desc, eq, gte, inArray, lt, type SQL } from 'drizzle-orm';
import {
  buildActivityView,
  collectActivityRefs,
  emptyActivityLookup,
  type ActivityFilters,
  type ActivityLookup,
  type ActivityView,
} from './activity-view';
import { approvalTitleOf } from './activity-correlation';

export { newActivityCorrelationId, approvalTitleOf } from './activity-correlation';

export async function loadActivityLookup(companyId: string, entries: ActivityLogEntry[]): Promise<ActivityLookup> {
  const refs = collectActivityRefs(entries);
  const lookup = emptyActivityLookup();
  const ids = (s: Set<string>) => [...s];

  await Promise.all([
    refs.issue.size > 0
      ? db
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.id, ids(refs.issue))))
          .then((rows) => rows.forEach((r) => lookup.issues.set(r.id, { identifier: r.identifier, title: r.title })))
      : null,
    refs.run.size > 0
      ? db
          .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId })
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, ids(refs.run))))
          .then((rows) => rows.forEach((r) => lookup.runs.set(r.id, { agentId: r.agentId })))
      : null,
    refs.approval.size > 0
      ? db
          .select({ id: approvals.id, type: approvals.type, status: approvals.status, payload: approvals.payload, hitlRequest: approvals.hitlRequest })
          .from(approvals)
          .where(and(eq(approvals.companyId, companyId), inArray(approvals.id, ids(refs.approval))))
          .then((rows) => rows.forEach((r) => lookup.approvals.set(r.id, { title: approvalTitleOf(r), status: r.status })))
      : null,
    refs.project.size > 0
      ? db
          .select({ id: projects.id, title: projects.title })
          .from(projects)
          .where(and(eq(projects.companyId, companyId), inArray(projects.id, ids(refs.project))))
          .then((rows) => rows.forEach((r) => lookup.projects.set(r.id, { title: r.title })))
      : null,
    refs.goal.size > 0
      ? db
          .select({ id: goals.id, title: goals.title })
          .from(goals)
          .where(and(eq(goals.companyId, companyId), inArray(goals.id, ids(refs.goal))))
          .then((rows) => rows.forEach((r) => lookup.goals.set(r.id, { title: r.title })))
      : null,
  ]);

  // Agents last: runs add their agent so a run row can name who ran it.
  for (const run of lookup.runs.values()) refs.agent.add(run.agentId);
  if (refs.agent.size > 0) {
    const rows = await db
      .select({ id: agents.id, name: agents.name, urlKey: agents.urlKey })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, ids(refs.agent))));
    rows.forEach((r) => lookup.agents.set(r.id, { name: r.name, urlKey: r.urlKey }));
  }
  return lookup;
}

export async function toActivityViews(companyId: string, entries: ActivityLogEntry[]): Promise<ActivityView[]> {
  const lookup = await loadActivityLookup(companyId, entries);
  return entries.map((entry) => buildActivityView(entry, lookup));
}

export function activityFilterConditions(companyId: string, filters: ActivityFilters): SQL[] {
  const conds: SQL[] = [eq(activityLog.companyId, companyId)];
  if (filters.entityType) conds.push(eq(activityLog.entityType, filters.entityType));
  if (filters.actor?.type === 'agent') {
    conds.push(eq(activityLog.actorType, 'agent'), eq(activityLog.actorId, filters.actor.id));
  } else if (filters.actor) {
    conds.push(eq(activityLog.actorType, filters.actor.type));
  }
  if (filters.from) conds.push(gte(activityLog.createdAt, filters.from));
  if (filters.toExclusive) conds.push(lt(activityLog.createdAt, filters.toExclusive));
  if (filters.correlationId) conds.push(eq(activityLog.correlationId, filters.correlationId));
  return conds;
}

export const ACTIVITY_PAGE_LIMIT = 200;

/** Company-wide Activity page. */
export async function listCompanyActivity(
  companyId: string,
  filters: ActivityFilters,
  limit = ACTIVITY_PAGE_LIMIT,
): Promise<ActivityView[]> {
  const entries = await db
    .select()
    .from(activityLog)
    .where(and(...activityFilterConditions(companyId, filters)))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(limit);
  return toActivityViews(companyId, entries);
}

/** Per-issue feed. */
export async function listIssueActivityViews(companyId: string, entries: ActivityLogEntry[]): Promise<ActivityView[]> {
  return toActivityViews(
    companyId,
    entries.filter((e) => e.companyId === companyId),
  );
}

/** Agents for the actor filter (this company only). */
export async function listActivityActorOptions(companyId: string): Promise<Array<{ value: string; label: string }>> {
  const rows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.companyId, companyId))
    .orderBy(asc(agents.name));
  return [
    { value: 'user', label: 'Board / dashboard' },
    { value: 'system', label: 'System' },
    ...rows.map((r) => ({ value: `agent:${r.id}`, label: `Agent ${r.name}` })),
  ];
}
