import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { getQueueOverview } from '@/lib/jobs';

export default async function JobsPage() {
  const { queues } = await getQueueOverview();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Jobs"
        description="Heartbeat runs (WakeRunner — Mastra schedules for timers/routines)"
      />

      <div className="grid gap-4 md:grid-cols-2">
        {queues.map((queue) => (
          <Link key={queue.name} href="/jobs/heartbeat">
            <Card className="h-full transition-colors hover:bg-muted/50">
              <CardContent className="space-y-3 p-4">
                <div>
                  <h2 className="font-semibold">{queue.label}</h2>
                  <p className="text-sm text-muted-foreground">{queue.description}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <CountBadge label="waiting" value={queue.counts.waiting} />
                  <CountBadge label="active" value={queue.counts.active} />
                  <CountBadge
                    label="failed"
                    value={queue.counts.failed}
                    highlight={queue.counts.failed > 0}
                  />
                  <CountBadge label="completed" value={queue.counts.completed} />
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

function CountBadge({
  label,
  value,
  highlight,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <Badge variant={highlight ? 'destructive' : 'secondary'}>
      {label}: {value}
    </Badge>
  );
}
