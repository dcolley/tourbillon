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
import { getOrCreateDefaultCompany } from './company';
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

export async function listProjectOptions(goalId?: string): Promise<ProjectOption[]> {
  const rows = await db
    .select({
      id: projects.id,
      title: projects.title,
      goalId: projects.goalId,
      status: projects.status,
    })
    .from(projects)
    .orderBy(desc(projects.updatedAt));

  if (goalId) {
    return rows.filter((p) => p.goalId === goalId);
  }
  return rows;
}

export async function listProjects(
  statusFilter?: ProjectStatus | 'all'
): Promise<Project[]> {
  const rows = await db.select().from(projects).orderBy(desc(projects.updatedAt)).limit(100);
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
    : await getOrCreateDefaultCompany();

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
