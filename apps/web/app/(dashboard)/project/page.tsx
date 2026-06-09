import Link from 'next/link';
import { db, agents, goals } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StatusBadge } from '@/lib/status-badges';
import { listProjects, type ProjectStatus } from '@/lib/projects';
import { listGoalOptions } from '@/lib/goals';
import { NewProjectDialog } from './new-project-dialog';

const FILTERS = [
  { id: 'active', label: 'Active' },
  { id: 'all', label: 'All' },
  { id: 'paused', label: 'Paused' },
  { id: 'completed', label: 'Completed' },
  { id: 'archived', label: 'Archived' },
] as const;

function parseFilter(value: string | undefined): ProjectStatus | 'all' {
  if (value === 'paused' || value === 'completed' || value === 'archived' || value === 'all') {
    return value;
  }
  return 'active';
}

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: { filter?: string };
}) {
  const filter = parseFilter(searchParams.filter);

  const [projectList, goalList, agentList, goalTitles] = await Promise.all([
    listProjects(filter),
    listGoalOptions(true),
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
    db.select({ id: goals.id, title: goals.title }).from(goals),
  ]);

  const goalTitleById = new Map(goalTitles.map((g) => [g.id, g.title]));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title="Projects"
        description="Deliverables under goals — assign an owner and break into issues"
        actions={<NewProjectDialog goals={goalList} agents={agentList} />}
      />

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f.id}
            variant={filter === f.id ? 'default' : 'outline'}
            size="sm"
            render={<Link href={f.id === 'active' ? '/project' : `/project?filter=${f.id}`} />}
          >
            {f.label}
          </Button>
        ))}
      </div>

      <p className="text-sm text-muted-foreground">
        {projectList.length} project{projectList.length === 1 ? '' : 's'}
      </p>

      {projectList.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No projects yet. Create a goal first, then add a project under it.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y">
              {projectList.map((project) => (
                <Link
                  key={project.id}
                  href={`/project/${project.id}`}
                  className="block p-4 transition-colors hover:bg-muted/50"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium">{project.title}</p>
                      {project.goalId && (
                        <p className="text-xs text-muted-foreground">
                          Goal: {goalTitleById.get(project.goalId) ?? project.goalId}
                        </p>
                      )}
                      {project.description && (
                        <p className="line-clamp-2 text-sm text-muted-foreground">{project.description}</p>
                      )}
                    </div>
                    <StatusBadge status={project.status} />
                  </div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
