import {
  db,
  issues,
  companies,
  agents,
  goals,
  projects,
  activityLog,
  heartbeatRuns,
  type Issue,
  type ActivityLogEntry,
  type HeartbeatRun,
} from '@tourbillon/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { IssuePriority, IssueStatus } from '@tourbillon/db';
import { getOrCreateDefaultCompany } from './company';
import { validateGoalId } from './goals';
import { validateProjectId } from './projects';
import { enqueueHeartbeat } from './queue';
import { findHeartbeatJobsForTask, type JobSummary } from './jobs';

const PRIORITIES: IssuePriority[] = ['critical', 'high', 'medium', 'low'];
const STATUSES: IssueStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'blocked',
  'cancelled',
];

export class IssueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IssueValidationError';
  }
}

export interface IssueActor {
  type: 'agent' | 'user' | 'system';
  id: string;
  name?: string;
}

export interface CreateIssueInput {
  title: string;
  description?: string;
  priority?: string;
  status?: string;
  assigneeAgentId?: string | null;
  goalId?: string | null;
  projectId?: string | null;
  companyId?: string;
  createdBy?: IssueActor;
}

export async function logIssueCreated(
  companyId: string,
  issue: Issue,
  actor: IssueActor,
  extraDetails: Record<string, unknown> = {}
): Promise<void> {
  await db.insert(activityLog).values({
    companyId,
    actorType: actor.type,
    actorId: actor.id,
    actorName: actor.name,
    action: 'issue.created',
    entityType: 'issue',
    entityId: issue.id,
    details: {
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      source: issue.source,
      goalId: issue.goalId,
      projectId: issue.projectId,
      assigneeAgentId: issue.assigneeAgentId,
      parentId: issue.parentId,
      createdBy: actor.name ?? actor.id,
      createdByType: actor.type,
      ...extraDetails,
    },
  });
}

async function resolveGoalAndProject(
  companyId: string,
  goalId?: string | null,
  projectId?: string | null
): Promise<{ goalId: string | null; projectId: string | null }> {
  let resolvedGoalId = goalId || null;
  const resolvedProjectId = projectId || null;

  if (resolvedProjectId) {
    const project = await validateProjectId(resolvedProjectId, companyId);
    if (!resolvedGoalId) {
      resolvedGoalId = project.goalId;
    } else if (project.goalId && resolvedGoalId !== project.goalId) {
      throw new IssueValidationError('Goal does not match the selected project.');
    }
  }

  if (resolvedGoalId) {
    await validateGoalId(resolvedGoalId, companyId);
  }

  return { goalId: resolvedGoalId, projectId: resolvedProjectId };
}

export async function createIssue(input: CreateIssueInput): Promise<Issue> {
  const title = input.title?.trim();
  if (!title) throw new IssueValidationError('Title is required.');

  const priority = (input.priority ?? 'medium') as IssuePriority;
  if (!PRIORITIES.includes(priority)) {
    throw new IssueValidationError('Invalid priority.');
  }

  const status = (input.status ?? 'todo') as IssueStatus;
  if (!STATUSES.includes(status)) {
    throw new IssueValidationError('Invalid status.');
  }

  const company = input.companyId
    ? await db.query.companies.findFirst({ where: eq(companies.id, input.companyId) })
    : await getOrCreateDefaultCompany();

  if (!company) throw new IssueValidationError('Company not found.');

  if (input.assigneeAgentId) {
    const agent = await db.query.agents.findFirst({
      where: and(eq(agents.id, input.assigneeAgentId), eq(agents.companyId, company.id)),
    });
    if (!agent) throw new IssueValidationError('Assignee agent not found.');
  }

  const { goalId, projectId } = await resolveGoalAndProject(
    company.id,
    input.goalId,
    input.projectId
  );

  const [updatedCompany] = await db
    .update(companies)
    .set({ issueCounter: company.issueCounter + 1 })
    .where(eq(companies.id, company.id))
    .returning();

  const identifier = `${company.issuePrefix}-${updatedCompany.issueCounter}`;

  const [created] = await db
    .insert(issues)
    .values({
      companyId: company.id,
      identifier,
      title,
      description: input.description?.trim() || null,
      status,
      priority,
      assigneeAgentId: input.assigneeAgentId ?? null,
      goalId,
      projectId,
      source: 'manual',
    })
    .returning();

  if (input.assigneeAgentId) {
    await enqueueHeartbeat({
      agentId: input.assigneeAgentId,
      companyId: company.id,
      invocationSource: 'assignment',
      wakeReason: 'assignment',
      taskId: created.id,
    });
  }

  await logIssueCreated(
    company.id,
    created,
    input.createdBy ?? { type: 'user', id: 'dashboard', name: 'Dashboard' }
  );

  return created;
}

export interface IssueAgentOption {
  id: string;
  name: string;
  urlKey: string;
}

export interface IssueGoalOption {
  id: string;
  title: string;
}

export interface IssueProjectOption {
  id: string;
  title: string;
}

export interface IssueDetail {
  issue: Issue;
  assignee: IssueAgentOption | null;
  goal: IssueGoalOption | null;
  project: IssueProjectOption | null;
  activity: ActivityLogEntry[];
  heartbeatRuns: HeartbeatRun[];
  heartbeatJobs: JobSummary[];
}

export async function getIssueDetail(issueId: string): Promise<IssueDetail | null> {
  const row = await db
    .select({ issue: issues, agent: agents, goal: goals, project: projects })
    .from(issues)
    .leftJoin(agents, eq(issues.assigneeAgentId, agents.id))
    .leftJoin(goals, eq(issues.goalId, goals.id))
    .leftJoin(projects, eq(issues.projectId, projects.id))
    .where(eq(issues.id, issueId))
    .limit(1);

  const record = row[0];
  if (!record) return null;

  const [activity, heartbeatJobs] = await Promise.all([
    db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityType, 'issue'), eq(activityLog.entityId, issueId)))
      .orderBy(desc(activityLog.createdAt))
      .limit(100),
    findHeartbeatJobsForTask(issueId),
  ]);

  const runIds = new Set<string>();
  if (record.issue.checkoutRunId) runIds.add(record.issue.checkoutRunId);
  for (const entry of activity) {
    const runId = (entry.details as Record<string, unknown> | null)?.runId;
    if (typeof runId === 'string') runIds.add(runId);
  }

  const runs =
    runIds.size > 0
      ? await db
          .select()
          .from(heartbeatRuns)
          .where(inArray(heartbeatRuns.id, [...runIds]))
          .orderBy(desc(heartbeatRuns.startedAt))
      : [];

  return {
    issue: record.issue,
    assignee: record.agent
      ? { id: record.agent.id, name: record.agent.name, urlKey: record.agent.urlKey }
      : null,
    goal: record.goal ? { id: record.goal.id, title: record.goal.title } : null,
    project: record.project ? { id: record.project.id, title: record.project.title } : null,
    activity,
    heartbeatRuns: runs,
    heartbeatJobs,
  };
}

export interface UpdateIssueInput {
  title?: string;
  description?: string | null;
  priority?: string;
  status?: string;
  assigneeAgentId?: string | null;
  goalId?: string | null;
  projectId?: string | null;
}

export async function updateIssue(issueId: string, input: UpdateIssueInput): Promise<Issue> {
  const issue = await db.query.issues.findFirst({ where: eq(issues.id, issueId) });
  if (!issue) throw new IssueValidationError('Issue not found.');

  const updates: Partial<Issue> & { updatedAt: Date } = { updatedAt: new Date() };
  const changed: Record<string, unknown> = {};

  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) throw new IssueValidationError('Title is required.');
    if (title !== issue.title) {
      updates.title = title;
      changed.title = title;
    }
  }

  if (input.description !== undefined) {
    const description = input.description?.trim() || null;
    if (description !== issue.description) {
      updates.description = description;
      changed.description = description;
    }
  }

  if (input.priority !== undefined) {
    const priority = input.priority as IssuePriority;
    if (!PRIORITIES.includes(priority)) {
      throw new IssueValidationError('Invalid priority.');
    }
    if (priority !== issue.priority) {
      updates.priority = priority;
      changed.priority = priority;
    }
  }

  if (input.status !== undefined) {
    const status = input.status as IssueStatus;
    if (!STATUSES.includes(status)) {
      throw new IssueValidationError('Invalid status.');
    }
    if (status !== issue.status) {
      updates.status = status;
      changed.status = status;
      if (status === 'in_progress' && !issue.startedAt) {
        updates.startedAt = new Date();
        changed.startedAt = updates.startedAt;
      }
      if (status === 'done') {
        updates.completedAt = new Date();
        changed.completedAt = updates.completedAt;
      }
      if (['done', 'cancelled', 'blocked', 'in_review'].includes(status)) {
        updates.checkoutRunId = null;
        updates.executionLockedAt = null;
        updates.executionAgentNameKey = null;
      }
    }
  }

  if (input.assigneeAgentId !== undefined) {
    const assigneeAgentId = input.assigneeAgentId || null;
    if (assigneeAgentId) {
      const agent = await db.query.agents.findFirst({
        where: and(eq(agents.id, assigneeAgentId), eq(agents.companyId, issue.companyId)),
      });
      if (!agent) throw new IssueValidationError('Assignee agent not found.');
    }
    if (assigneeAgentId !== issue.assigneeAgentId) {
      updates.assigneeAgentId = assigneeAgentId;
      changed.assigneeAgentId = assigneeAgentId;
    }
  }

  const goalOrProjectTouched =
    input.goalId !== undefined || input.projectId !== undefined;

  if (goalOrProjectTouched) {
    const nextGoalId = input.goalId !== undefined ? input.goalId || null : issue.goalId;
    const nextProjectId =
      input.projectId !== undefined ? input.projectId || null : issue.projectId;

    const { goalId: resolvedGoalId, projectId: resolvedProjectId } =
      await resolveGoalAndProject(issue.companyId, nextGoalId, nextProjectId);

    if (resolvedGoalId !== issue.goalId) {
      updates.goalId = resolvedGoalId;
      changed.goalId = resolvedGoalId;
    }
    if (resolvedProjectId !== issue.projectId) {
      updates.projectId = resolvedProjectId;
      changed.projectId = resolvedProjectId;
    }
  }

  if (Object.keys(changed).length === 0) {
    return issue;
  }

  const [updated] = await db.update(issues).set(updates).where(eq(issues.id, issueId)).returning();

  await db.insert(activityLog).values({
    companyId: issue.companyId,
    actorType: 'user',
    actorId: 'dashboard',
    actorName: 'Dashboard',
    action: 'issue.updated',
    entityType: 'issue',
    entityId: issueId,
    details: changed,
  });

  if (
    input.assigneeAgentId &&
    input.assigneeAgentId !== issue.assigneeAgentId
  ) {
    await enqueueHeartbeat({
      agentId: input.assigneeAgentId,
      companyId: issue.companyId,
      invocationSource: 'assignment',
      wakeReason: 'assignment',
      taskId: issueId,
    });
  }

  return updated;
}

export const ISSUE_LIST_PAGE_SIZE = 25;
export const ISSUE_KANBAN_LIMIT = 500;

export type IssueListRow = {
  issue: Issue;
  agent: { id: string; name: string; urlKey: string } | null;
};

export interface IssueListResult {
  rows: IssueListRow[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listIssues(opts: {
  statuses: readonly string[];
  page?: number;
  pageSize?: number;
}): Promise<IssueListResult> {
  const page = Math.max(0, opts.page ?? 0);
  const pageSize = opts.pageSize ?? ISSUE_LIST_PAGE_SIZE;
  const company = await getOrCreateDefaultCompany();
  const statusList = opts.statuses as IssueStatus[];

  const where = and(
    eq(issues.companyId, company.id),
    statusList.length > 0 ? inArray(issues.status, statusList) : undefined,
  );

  const [rows, countRow] = await Promise.all([
    db
      .select({
        issue: issues,
        agent: {
          id: agents.id,
          name: agents.name,
          urlKey: agents.urlKey,
        },
      })
      .from(issues)
      .leftJoin(agents, eq(issues.assigneeAgentId, agents.id))
      .where(where)
      .orderBy(desc(issues.updatedAt))
      .limit(pageSize)
      .offset(page * pageSize),
    db.select({ count: sql<number>`count(*)::int` }).from(issues).where(where),
  ]);

  return {
    rows: rows.map((r) => ({
      issue: r.issue,
      agent: r.agent?.id ? r.agent : null,
    })),
    total: countRow[0]?.count ?? 0,
    page,
    pageSize,
  };
}

export async function listIssueAgentOptions(): Promise<IssueAgentOption[]> {
  return db
    .select({ id: agents.id, name: agents.name, urlKey: agents.urlKey })
    .from(agents)
    .orderBy(agents.name);
}
