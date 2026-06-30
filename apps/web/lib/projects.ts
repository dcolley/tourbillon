import {
  db,
  projects,
  goals,
  issues,
  agents,
  companies,
  activityLog,
  type Project,
  type Issue,
} from '@tourbillon/db';
import { and, desc, eq } from 'drizzle-orm';
import { assertCompanyAccess, getActiveCompany } from './company';
import { validateGoalId } from './goals';

export class ProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectValidationError';
  }
}

export type ProjectStatus = 'active' | 'paused' | 'completed' | 'archived';

const PROJECT_STATUSES: ProjectStatus[] = ['active', 'paused', 'completed', 'archived'];

export interface ProjectOption {
  id: string;
  title: string;
  goalId: string | null;
  status: string;
}

export interface ProjectGoalOption {
  id: string;
  title: string;
}

export interface ProjectOwnerOption {
  id: string;
  name: string;
  urlKey: string;
}

export interface ProjectIssueRow {
  issue: Issue;
  assignee: { id: string; name: string; urlKey: string } | null;
}

export interface ProjectDetail {
  project: Project;
  goal: ProjectGoalOption | null;
  owner: ProjectOwnerOption | null;
  issues: ProjectIssueRow[];
  stats: {
    total: number;
    done: number;
    inProgress: number;
    blocked: number;
  };
}

export interface CreateProjectInput {
  title: string;
  description?: string;
  status?: string;
  goalId: string;
  ownerAgentId?: string | null;
  companyId?: string;
}

export async function listProjectOptions(goalId?: string, companyId?: string): Promise<ProjectOption[]> {
  const company = companyId
    ? await db.query.companies.findFirst({ where: eq(companies.id, companyId) })
    : await getActiveCompany();
  if (!company) return [];
  const rows = await db
    .select({
      id: projects.id,
      title: projects.title,
      goalId: projects.goalId,
      status: projects.status,
    })
    .from(projects)
    .where(eq(projects.companyId, company.id))
    .orderBy(desc(projects.updatedAt));

  if (goalId) {
    return rows.filter((p) => p.goalId === goalId);
  }
  return rows;
}

export async function listProjects(
  statusFilter?: ProjectStatus | 'all'
): Promise<Project[]> {
  const company = await getActiveCompany();
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.companyId, company.id))
    .orderBy(desc(projects.updatedAt))
    .limit(100);
  if (!statusFilter || statusFilter === 'all') return rows;
  return rows.filter((p) => p.status === statusFilter);
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const title = input.title?.trim();
  if (!title) throw new ProjectValidationError('Title is required.');

  const goalId = input.goalId?.trim();
  if (!goalId) throw new ProjectValidationError('Goal is required.');

  const status = (input.status ?? 'active') as ProjectStatus;
  if (!PROJECT_STATUSES.includes(status)) {
    throw new ProjectValidationError('Invalid status.');
  }

  const company = input.companyId
    ? await db.query.companies.findFirst({ where: eq(companies.id, input.companyId) })
    : await getActiveCompany();

  if (!company) throw new ProjectValidationError('Company not found.');

  await validateGoalId(goalId, company.id);

  if (input.ownerAgentId) {
    const agent = await db.query.agents.findFirst({
      where: and(eq(agents.id, input.ownerAgentId), eq(agents.companyId, company.id)),
    });
    if (!agent) throw new ProjectValidationError('Owner agent not found.');
  }

  const [created] = await db
    .insert(projects)
    .values({
      companyId: company.id,
      goalId,
      title,
      description: input.description?.trim() || null,
      status,
      ownerAgentId: input.ownerAgentId ?? null,
    })
    .returning();

  await db.insert(activityLog).values({
    companyId: company.id,
    actorType: 'user',
    actorId: 'dashboard',
    actorName: 'Dashboard',
    action: 'project.created',
    entityType: 'project',
    entityId: created.id,
    details: { title: created.title, status, goalId, ownerAgentId: created.ownerAgentId },
  });

  return created;
}

export interface UpdateProjectInput {
  title?: string;
  description?: string | null;
  status?: string;
  goalId?: string;
  ownerAgentId?: string | null;
}

export async function updateProject(projectId: string, input: UpdateProjectInput): Promise<Project> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new ProjectValidationError('Project not found.');

  const activeCompany = await getActiveCompany();
  assertCompanyAccess(project.companyId, activeCompany.id);

  const updates: Partial<Project> & { updatedAt: Date } = { updatedAt: new Date() };
  const changed: Record<string, unknown> = {};

  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) throw new ProjectValidationError('Title is required.');
    if (title !== project.title) {
      updates.title = title;
      changed.title = title;
    }
  }

  if (input.description !== undefined) {
    const description = input.description?.trim() || null;
    if (description !== project.description) {
      updates.description = description;
      changed.description = description;
    }
  }

  if (input.status !== undefined) {
    const status = input.status as ProjectStatus;
    if (!PROJECT_STATUSES.includes(status)) {
      throw new ProjectValidationError('Invalid status.');
    }
    if (status !== project.status) {
      updates.status = status;
      changed.status = status;
    }
  }

  if (input.goalId !== undefined) {
    const goalId = input.goalId.trim();
    if (!goalId) throw new ProjectValidationError('Goal is required.');
    await validateGoalId(goalId, project.companyId);
    if (goalId !== project.goalId) {
      updates.goalId = goalId;
      changed.goalId = goalId;
    }
  }

  if (input.ownerAgentId !== undefined) {
    const ownerAgentId = input.ownerAgentId || null;
    if (ownerAgentId) {
      const agent = await db.query.agents.findFirst({
        where: and(eq(agents.id, ownerAgentId), eq(agents.companyId, project.companyId)),
      });
      if (!agent) throw new ProjectValidationError('Owner agent not found.');
    }
    if (ownerAgentId !== project.ownerAgentId) {
      updates.ownerAgentId = ownerAgentId;
      changed.ownerAgentId = ownerAgentId;
    }
  }

  if (Object.keys(changed).length === 0) {
    return project;
  }

  const [updated] = await db
    .update(projects)
    .set(updates)
    .where(eq(projects.id, projectId))
    .returning();

  await db.insert(activityLog).values({
    companyId: project.companyId,
    actorType: 'user',
    actorId: 'dashboard',
    actorName: 'Dashboard',
    action: 'project.updated',
    entityType: 'project',
    entityId: projectId,
    details: changed,
  });

  return updated;
}

export async function getProjectDetail(projectId: string): Promise<ProjectDetail | null> {
  const row = await db
    .select({ project: projects, goal: goals, owner: agents })
    .from(projects)
    .leftJoin(goals, eq(projects.goalId, goals.id))
    .leftJoin(agents, eq(projects.ownerAgentId, agents.id))
    .where(eq(projects.id, projectId))
    .limit(1);

  const record = row[0];
  if (!record) return null;

  const issueRows = await db
    .select({ issue: issues, agent: agents })
    .from(issues)
    .leftJoin(agents, eq(issues.assigneeAgentId, agents.id))
    .where(eq(issues.projectId, projectId))
    .orderBy(desc(issues.updatedAt));

  const mapped: ProjectIssueRow[] = issueRows.map(({ issue, agent }) => ({
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
    project: record.project,
    goal: record.goal ? { id: record.goal.id, title: record.goal.title } : null,
    owner: record.owner
      ? { id: record.owner.id, name: record.owner.name, urlKey: record.owner.urlKey }
      : null,
    issues: mapped,
    stats,
  };
}

export async function validateProjectId(
  projectId: string,
  companyId: string
): Promise<Project> {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, projectId), eq(projects.companyId, companyId)),
  });
  if (!project) throw new ProjectValidationError('Project not found.');
  return project;
}

export interface GoalProjectRow {
  id: string;
  title: string;
  status: string;
  owner: { id: string; name: string; urlKey: string } | null;
}

export async function listProjectsForGoal(goalId: string): Promise<GoalProjectRow[]> {
  const rows = await db
    .select({ project: projects, owner: agents })
    .from(projects)
    .leftJoin(agents, eq(projects.ownerAgentId, agents.id))
    .where(eq(projects.goalId, goalId))
    .orderBy(desc(projects.updatedAt));

  return rows.map(({ project, owner }) => ({
    id: project.id,
    title: project.title,
    status: project.status,
    owner: owner ? { id: owner.id, name: owner.name, urlKey: owner.urlKey } : null,
  }));
}

export interface AgentProjectListItem {
  id: string;
  title: string;
  description: string | null;
  status: string;
  goalId: string | null;
  goalTitle: string | null;
  owner: { id: string; name: string; urlKey: string } | null;
  stats: {
    total: number;
    done: number;
    inProgress: number;
    blocked: number;
  };
}

export async function listProjectsForAgent(
  companyId: string,
  filters?: { goalId?: string; status?: ProjectStatus | 'all' },
): Promise<AgentProjectListItem[]> {
  const conditions = [eq(projects.companyId, companyId)];
  if (filters?.goalId) {
    conditions.push(eq(projects.goalId, filters.goalId));
  }

  const rows = await db
    .select({ project: projects, goal: goals, owner: agents })
    .from(projects)
    .leftJoin(goals, eq(projects.goalId, goals.id))
    .leftJoin(agents, eq(projects.ownerAgentId, agents.id))
    .where(and(...conditions))
    .orderBy(desc(projects.updatedAt))
    .limit(100);

  const statusFilter = filters?.status ?? 'all';
  const filtered =
    statusFilter === 'all' ? rows : rows.filter(({ project }) => project.status === statusFilter);

  const results: AgentProjectListItem[] = [];
  for (const { project, goal, owner } of filtered) {
    const detail = await getProjectDetail(project.id);
    if (!detail) continue;
    results.push({
      id: project.id,
      title: project.title,
      description: project.description,
      status: project.status,
      goalId: project.goalId,
      goalTitle: goal?.title ?? null,
      owner: owner ? { id: owner.id, name: owner.name, urlKey: owner.urlKey } : null,
      stats: detail.stats,
    });
  }
  return results;
}

export interface AgentProjectDetail {
  project: {
    id: string;
    title: string;
    description: string | null;
    status: string;
    goalId: string | null;
  };
  goal: ProjectGoalOption | null;
  owner: ProjectOwnerOption | null;
  stats: ProjectDetail['stats'];
  issues: Array<{
    id: string;
    identifier: string;
    title: string;
    status: string;
    priority: string;
    assigneeAgentId: string | null;
    assignee: { id: string; name: string; urlKey: string } | null;
  }>;
}

export async function getProjectDetailForAgent(
  projectId: string,
  companyId: string,
): Promise<AgentProjectDetail | null> {
  const detail = await getProjectDetail(projectId);
  if (!detail || detail.project.companyId !== companyId) return null;

  return {
    project: {
      id: detail.project.id,
      title: detail.project.title,
      description: detail.project.description,
      status: detail.project.status,
      goalId: detail.project.goalId,
    },
    goal: detail.goal,
    owner: detail.owner,
    stats: detail.stats,
    issues: detail.issues.map(({ issue, assignee }) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      assigneeAgentId: issue.assigneeAgentId,
      assignee,
    })),
  };
}
