import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db, agents } from '@tourbillon/db';
import { eq, and } from 'drizzle-orm';
import { getProjectDetail } from '@/lib/projects';
import { listGoalOptions } from '@/lib/goals';
import { DeepLinkCompanySync } from '@/components/deep-link-company-sync';
import { getCompanyById } from '@/lib/company';
import { NewProjectIssueDialog } from '../new-project-issue-dialog';
import { updateProjectAction } from '../actions';
import { ProjectEditForm } from './project-edit-form';

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { projectId } = await params;
  const { saved } = await searchParams;

  const detail = await getProjectDetail(projectId);
  if (!detail) notFound();

  const { project, goal, owner, issues, stats } = detail;
  const company = await getCompanyById(project.companyId);

  const [agentList, goalList] = await Promise.all([
    db
      .select({
        id: agents.id,
        name: agents.name,
        urlKey: agents.urlKey,
        role: agents.role,
        title: agents.title,
      })
      .from(agents)
      .where(and(eq(agents.companyId, project.companyId), eq(agents.status, 'active')))
      .orderBy(agents.name),
    listGoalOptions(true, project.companyId),
  ]);
  const progressPct = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;
  const savedFlag = saved === '1';

  // Include current goal even if no longer active
  const goals =
    project.goalId && !goalList.some((g) => g.id === project.goalId) && goal
      ? [{ id: goal.id, title: goal.title }, ...goalList]
      : goalList;

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      {company ? (
        <DeepLinkCompanySync requiredCompanyId={company.id} requiredCompanyName={company.name} />
      ) : null}
      <div>
        <Link href="/project" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to projects
        </Link>
        <div className="flex items-start justify-between gap-4 mt-2">
          <div className="space-y-1 min-w-0">
            <p className="text-sm capitalize text-muted-foreground">{project.status}</p>
            <h1 className="text-2xl font-bold tracking-tight">{project.title}</h1>
            {goal && (
              <p className="text-sm text-muted-foreground">
                Goal:{' '}
                <Link href={`/goal/${goal.id}`} className="hover:text-foreground underline-offset-4 hover:underline">
                  {goal.title}
                </Link>
              </p>
            )}
            {owner ? (
              <p className="text-sm text-muted-foreground">
                Owner:{' '}
                <Link href={`/agent/${owner.urlKey}`} className="hover:text-foreground underline-offset-4 hover:underline">
                  {owner.name}
                </Link>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">No owner assigned</p>
            )}
            {project.description && (
              <p className="text-muted-foreground whitespace-pre-wrap pt-1">{project.description}</p>
            )}
          </div>
          <NewProjectIssueDialog projectId={project.id} agents={agentList} />
        </div>
      </div>

      {savedFlag && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200">
          Changes saved.
        </div>
      )}

      <ProjectEditForm
        project={project}
        goals={goals}
        agents={agentList}
        action={updateProjectAction}
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Issues" value={String(stats.total)} />
        <StatCard label="Done" value={String(stats.done)} />
        <StatCard label="In progress" value={String(stats.inProgress)} />
        <StatCard label="Progress" value={`${progressPct}%`} />
      </div>

      <section>
        <h2 className="text-lg font-semibold mb-3">Issues</h2>
        {issues.length === 0 ? (
          <p className="border rounded-lg p-4 text-sm text-muted-foreground">
            No issues for this project yet. Add an issue and assign it to an agent.
          </p>
        ) : (
          <div className="border rounded-lg divide-y">
            {issues.map(({ issue, assignee }) => (
              <Link
                key={issue.id}
                href={`/issue/${issue.id}`}
                className="flex items-start justify-between gap-4 p-4 hover:bg-muted/30 transition-colors"
              >
                <div className="space-y-0.5 min-w-0">
                  <p className="font-mono text-xs text-muted-foreground">{issue.identifier}</p>
                  <p className="text-sm font-medium">{issue.title}</p>
                  {assignee ? (
                    <p className="text-xs text-muted-foreground">{assignee.name}</p>
                  ) : (
                    <p className="text-xs text-amber-600 dark:text-amber-400">Unassigned</p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-0.5 shrink-0 text-xs capitalize text-muted-foreground">
                  <span>{issue.status.replace(/_/g, ' ')}</span>
                  <span>{issue.priority}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border rounded-lg p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
  );
}
