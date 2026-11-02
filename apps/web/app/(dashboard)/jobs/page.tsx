import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { getQueueOverview } from '@/lib/jobs';
import { QueueCountBadges } from './queue-count-badges';

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
                <QueueCountBadges counts={queue.counts} />
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
