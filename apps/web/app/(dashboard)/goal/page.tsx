import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StatusBadge } from '@/lib/status-badges';
import { listGoals, type GoalStatus } from '@/lib/goals';
import { NewGoalDialog } from './new-goal-dialog';

const FILTERS = [
  { id: 'active', label: 'Active' },
  { id: 'all', label: 'All' },
  { id: 'completed', label: 'Completed' },
  { id: 'archived', label: 'Archived' },
] as const;

function parseFilter(value: string | undefined): GoalStatus | 'all' {
  if (value === 'completed' || value === 'archived' || value === 'all') return value;
  return 'active';
}

export default async function GoalsPage({
  searchParams,
}: {
  searchParams: { filter?: string };
}) {
  const filter = parseFilter(searchParams.filter);
  const goalList = await listGoals(filter);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title="Goals"
        description="Company objectives — review progress and assign tasks to agents"
        actions={<NewGoalDialog />}
      />

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f.id}
            variant={filter === f.id ? 'default' : 'outline'}
            size="sm"
            render={<Link href={f.id === 'active' ? '/goal' : `/goal?filter=${f.id}`} />}
          >
            {f.label}
          </Button>
        ))}
      </div>

      <p className="text-sm text-muted-foreground">
        {goalList.length} goal{goalList.length === 1 ? '' : 's'}
      </p>

      {goalList.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No goals yet. Create one to define an objective and break it into agent tasks.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y">
              {goalList.map((goal) => (
                <Link
                  key={goal.id}
                  href={`/goal/${goal.id}`}
                  className="block p-4 transition-colors hover:bg-muted/50"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium">{goal.title}</p>
                      {goal.description && (
                        <p className="line-clamp-2 text-sm text-muted-foreground">{goal.description}</p>
                      )}
                    </div>
                    <StatusBadge status={goal.status} />
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
