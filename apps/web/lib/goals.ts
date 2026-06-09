import { db, goals, issues, agents, companies, activityLog, type Goal, type Issue } from '@tourbillon/db';
import { and, desc, eq } from 'drizzle-orm';
import { getOrCreateDefaultCompany } from './company';
import { listProjectsForGoal, type GoalProjectRow } from './projects';

export class GoalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoalValidationError';
  }
}

export type GoalStatus = 'active' | 'completed' | 'archived';

const GOAL_STATUSES: GoalStatus[] = ['active', 'completed', 'archived'];

export interface GoalOption {
  id: string;
  title: string;
  status: string;
}

export interface GoalIssueRow {
  issue: Issue;
  assignee: { id: string; name: string; urlKey: string } | null;
}

export interface GoalOwnerOption {
  id: string;
  name: string;
  urlKey: string;
}

export interface GoalDetail {
  goal: Goal;
  owner: GoalOwnerOption | null;
  projects: GoalProjectRow[];
  issues: GoalIssueRow[];
  stats: {
    total: number;
    done: number;
    inProgress: number;
    blocked: number;
  };
}

export interface CreateGoalInput {
  title: string;
  description?: string;
  status?: string;
  companyId?: string;
}

export async function listGoalOptions(activeOnly = false): Promise<GoalOption[]> {
  const rows = await db
    .select({ id: goals.id, title: goals.title, status: goals.status })
    .from(goals)
    .orderBy(desc(goals.updatedAt));

  if (activeOnly) {
    return rows.filter((g) => g.status === 'active');
  }
  return rows;
}

export async function listGoals(statusFilter?: GoalStatus | 'all'): Promise<Goal[]> {
  const rows = await db.select().from(goals).orderBy(desc(goals.updatedAt)).limit(100);
  if (!statusFilter || statusFilter === 'all') return rows;
  return rows.filter((g) => g.status === statusFilter);
}

export async function createGoal(input: CreateGoalInput): Promise<Goal> {
  const title = input.title?.trim();
  if (!title) throw new GoalValidationError('Title is required.');

  const status = (input.status ?? 'active') as GoalStatus;
  if (!GOAL_STATUSES.includes(status)) {
    throw new GoalValidationError('Invalid status.');
  }

  const company = input.companyId
    ? await db.query.companies.findFirst({ where: eq(companies.id, input.companyId) })
    : await getOrCreateDefaultCompany();

  if (!company) throw new GoalValidationError('Company not found.');

  const [created] = await db
    .insert(goals)
    .values({
      companyId: company.id,
      title,
      description: input.description?.trim() || null,
      status,
    })
    .returning();

  await db.insert(activityLog).values({
    companyId: company.id,
    actorType: 'user',
    actorId: 'dashboard',
    actorName: 'Dashboard',
    action: 'goal.created',
    entityType: 'goal',
    entityId: created.id,
    details: { title: created.title, status },
  });

  return created;
}

export interface UpdateGoalInput {
  title?: string;
  description?: string | null;
  status?: string;
  ownerAgentId?: string | null;
}

export async function updateGoal(goalId: string, input: UpdateGoalInput): Promise<Goal> {
  const goal = await db.query.goals.findFirst({ where: eq(goals.id, goalId) });
  if (!goal) throw new GoalValidationError('Goal not found.');

  const updates: Partial<Goal> & { updatedAt: Date } = { updatedAt: new Date() };
  const changed: Record<string, unknown> = {};

  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) throw new GoalValidationError('Title is required.');
    if (title !== goal.title) {
      updates.title = title;
      changed.title = title;
    }
  }

  if (input.description !== undefined) {
    const description = input.description?.trim() || null;
    if (description !== goal.description) {
      updates.description = description;
      changed.description = description;
    }
  }

  if (input.status !== undefined) {
    const status = input.status as GoalStatus;
    if (!GOAL_STATUSES.includes(status)) {
      throw new GoalValidationError('Invalid status.');
    }
    if (status !== goal.status) {
      updates.status = status;
      changed.status = status;
    }
  }

  if (input.ownerAgentId !== undefined) {
    const ownerAgentId = input.ownerAgentId || null;
    if (ownerAgentId) {
      const agent = await db.query.agents.findFirst({
        where: and(eq(agents.id, ownerAgentId), eq(agents.companyId, goal.companyId)),
      });
      if (!agent) throw new GoalValidationError('Owner agent not found.');
    }
    if (ownerAgentId !== goal.ownerAgentId) {
      updates.ownerAgentId = ownerAgentId;
      changed.ownerAgentId = ownerAgentId;
    }
  }

  if (Object.keys(changed).length === 0) {
    return goal;
  }

  const [updated] = await db.update(goals).set(updates).where(eq(goals.id, goalId)).returning();

  await db.insert(activityLog).values({
    companyId: goal.companyId,
    actorType: 'user',
    actorId: 'dashboard',
    actorName: 'Dashboard',
    action: 'goal.updated',
    entityType: 'goal',
    entityId: goalId,
    details: changed,
  });

  return updated;
}

export async function getGoalDetail(goalId: string): Promise<GoalDetail | null> {
  const row = await db
    .select({ goal: goals, owner: agents })
    .from(goals)
    .leftJoin(agents, eq(goals.ownerAgentId, agents.id))
    .where(eq(goals.id, goalId))
    .limit(1);

  const record = row[0];
  if (!record) return null;

  const goal = record.goal;

  const [issueRows, projectList] = await Promise.all([
    db
      .select({ issue: issues, agent: agents })
      .from(issues)
      .leftJoin(agents, eq(issues.assigneeAgentId, agents.id))
      .where(eq(issues.goalId, goalId))
      .orderBy(desc(issues.updatedAt)),
    listProjectsForGoal(goalId),
  ]);

  const mapped: GoalIssueRow[] = issueRows.map(({ issue, agent }) => ({
    issue,
    assignee: agent ? { id: agent.id, name: agent.name, urlKey: agent.urlKey } : null,
  }));

  const stats = {
    total: mapped.length,
    done: mapped.filter((r) => r.issue.status === 'done').length,
    inProgress: mapped.filter((r) => r.issue.status === 'in_progress').length,
    blocked: mapped.filter((r) => r.issue.status === 'blocked').length,
  };

  return {
    goal,
    owner: record.owner
      ? { id: record.owner.id, name: record.owner.name, urlKey: record.owner.urlKey }
      : null,
    projects: projectList,
    issues: mapped,
    stats,
  };
}

export async function validateGoalId(goalId: string, companyId: string): Promise<void> {
  const goal = await db.query.goals.findFirst({
    where: and(eq(goals.id, goalId), eq(goals.companyId, companyId)),
  });
  if (!goal) throw new GoalValidationError('Goal not found.');
}

export interface GoalStats {
  total: number;
  done: number;
  inProgress: number;
  blocked: number;
}

export function computeGoalNeedsAttention(
  stats: GoalStats,
  goalStatus: string
): boolean {
  if (goalStatus !== 'active') return false;
  if (stats.total === 0) return true;
  if (stats.inProgress === 0 && stats.blocked > 0) return true;
  if (stats.total > 0 && stats.done === stats.total) return true;
  return false;
}

export async function listGoalsForCompany(
  companyId: string,
  statusFilter?: GoalStatus | 'all'
): Promise<Goal[]> {
  const rows = await db
    .select()
    .from(goals)
    .where(eq(goals.companyId, companyId))
    .orderBy(desc(goals.updatedAt))
    .limit(100);

  if (!statusFilter || statusFilter === 'all') return rows;
  return rows.filter((g) => g.status === statusFilter);
}

export interface AgentGoalListItem {
  id: string;
  title: string;
  description: string | null;
  status: string;
  stats: GoalStats;
  needsAttention: boolean;
}

export async function listGoalsForAgent(
  companyId: string,
  statusFilter: GoalStatus | 'all' = 'active'
): Promise<AgentGoalListItem[]> {
  const goalRows = await listGoalsForCompany(companyId, statusFilter);
  const results: AgentGoalListItem[] = [];

  for (const goal of goalRows) {
    const detail = await getGoalDetail(goal.id);
    if (!detail) continue;
    const needsAttention = computeGoalNeedsAttention(detail.stats, goal.status);
    results.push({
      id: goal.id,
      title: goal.title,
      description: goal.description,
      status: goal.status,
      stats: detail.stats,
      needsAttention,
    });
  }

  return results;
}

export interface AgentGoalDetail {
  goal: {
    id: string;
    title: string;
    description: string | null;
    status: string;
  };
  stats: GoalStats;
  needsAttention: boolean;
  issues: Array<{
    id: string;
    identifier: string;
    title: string;
    status: string;
    priority: string;
    parentId: string | null;
    assigneeAgentId: string | null;
    assignee: { id: string; name: string; urlKey: string } | null;
  }>;
}

export async function getGoalDetailForAgent(
  goalId: string,
  companyId: string
): Promise<AgentGoalDetail | null> {
  const detail = await getGoalDetail(goalId);
  if (!detail || detail.goal.companyId !== companyId) return null;

  return {
    goal: {
      id: detail.goal.id,
      title: detail.goal.title,
      description: detail.goal.description,
      status: detail.goal.status,
    },
    stats: detail.stats,
    needsAttention: computeGoalNeedsAttention(detail.stats, detail.goal.status),
    issues: detail.issues.map(({ issue, assignee }) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      parentId: issue.parentId,
      assigneeAgentId: issue.assigneeAgentId,
      assignee,
    })),
  };
}
