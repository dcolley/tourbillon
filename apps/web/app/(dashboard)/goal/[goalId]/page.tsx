import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db, agents } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { getGoalDetail } from '@/lib/goals';
import { NewProjectDialog } from '../../project/new-project-dialog';
import { NewGoalIssueDialog } from '../new-goal-issue-dialog';
import { updateGoalAction } from '../actions';
import { GoalEditForm } from './goal-edit-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/lib/status-badges';

export default async function GoalDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ goalId: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { goalId } = await params;
  const { saved } = await searchParams;
  const [detail, agentList] = await Promise.all([
    getGoalDetail(goalId),
    db
      .select({
        id: agents.id,
        name: agents.name,
        urlKey: agents.urlKey,
        role: agents.role,
        title: agents.title,
      })
      .from(agents)
      .where(eq(agents.status, 'active'))
      .orderBy(agents.name),
  ]);

  if (!detail) notFound();

  const { goal, owner, projects, issues, stats } = detail;
  const progressPct = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;
  const goalOption = [{ id: goal.id, title: goal.title }];
  const savedFlag = saved === '1';

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link href="/goal" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to goals
        </Link>
        <div className="flex items-start justify-between gap-4 mt-2">
          <div className="space-y-1 min-w-0">
            <p className="text-sm capitalize text-muted-foreground">{goal.status}</p>
            <h1 className="text-2xl font-bold tracking-tight">{goal.title}</h1>
            {owner ? (
              <p className="text-sm text-muted-foreground">
                Assigned to{' '}
                <Link href={`/agent/${owner.urlKey}`} className="hover:text-foreground underline-offset-4 hover:underline">
                  {owner.name}
                </Link>
              </p>
            ) : (
              <p className="text-sm text-amber-600 dark:text-amber-400">No agent assigned</p>
            )}
            {goal.description && (
              <p className="text-muted-foreground whitespace-pre-wrap pt-1">{goal.description}</p>
            )}
          </div>
          <div className="flex flex-col gap-2 shrink-0">
            <NewProjectDialog
              goals={goalOption}
              agents={agentList}
              defaultGoalId={goal.id}
              buttonLabel="+ New project"
            />
            <NewGoalIssueDialog goalId={goal.id} agents={agentList} />
          </div>
        </div>
      </div>

      {savedFlag && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200">
          Changes saved.
        </div>
      )}

      <GoalEditForm goal={goal} agents={agentList} action={updateGoalAction} />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Tasks" value={String(stats.total)} />
        <StatCard label="Done" value={String(stats.done)} />
        <StatCard label="In progress" value={String(stats.inProgress)} />
        <StatCard label="Progress" value={`${progressPct}%`} />
      </div>

      <section>
        <h2 className="text-lg font-semibold mb-3">Projects</h2>
        {projects.length === 0 ? (
          <p className="border rounded-lg p-4 text-sm text-muted-foreground">
            No projects under this goal yet. Create a project and assign an owner agent.
          </p>
        ) : (
          <div className="border rounded-lg divide-y">
            {projects.map((project) => (
              <Link
                key={project.id}
                href={`/project/${project.id}`}
                className="flex items-start justify-between gap-4 p-4 hover:bg-muted/30 transition-colors"
              >
                <div className="space-y-0.5 min-w-0">
                  <p className="text-sm font-medium">{project.title}</p>
                  {project.owner ? (
                    <p className="text-xs text-muted-foreground">Owner: {project.owner.name}</p>
                  ) : (
                    <p className="text-xs text-amber-600 dark:text-amber-400">No owner</p>
                  )}
                </div>
                <StatusBadge status={project.status} />
              </Link>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Tasks</h2>
        {issues.length === 0 ? (
          <p className="border rounded-lg p-4 text-sm text-muted-foreground">
            No tasks linked to this goal yet. Add a task and assign it to the best agent for execution.
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
                    <p className="text-xs text-muted-foreground">
                      {assignee.name} ·{' '}
                      <span className="font-mono">/agent/{assignee.urlKey}</span>
                    </p>
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

      {agentList.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold">Available agents</h2>
          <p className="text-xs text-muted-foreground mb-3">
            Pick the agent whose role best fits each task when creating work.
          </p>
          <div className="border rounded-lg divide-y">
            {agentList.map((agent) => (
              <Link
                key={agent.id}
                href={`/agent/${agent.urlKey}`}
                className="flex items-center justify-between gap-4 p-3 hover:bg-muted/30 transition-colors"
              >
                <div>
                  <p className="text-sm font-medium">{agent.name}</p>
                  <p className="text-xs text-muted-foreground">{agent.title}</p>
                </div>
                <span className="text-xs uppercase text-muted-foreground">{agent.role}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold tracking-tight">{value}</p>
      </CardContent>
    </Card>
  );
}
