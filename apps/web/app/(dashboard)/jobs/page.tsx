import Link from 'next/link';
import { QUEUE_HEARTBEAT } from '@tourbillon/shared';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { getQueueOverview } from '@/lib/jobs';

export default async function JobsPage() {
  const { queues, redisOk } = await getQueueOverview();

  return (
    <div className="space-y-6">
      <PageHeader title="Jobs" description="BullMQ queue overview" />

      {!redisOk && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Cannot connect to Redis. Start it with{' '}
          <code className="font-mono text-xs">docker compose up -d redis</code>.
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {queues.map((queue) => (
          <Link
            key={queue.name}
            href={queue.name === QUEUE_HEARTBEAT ? '/jobs/heartbeat' : `/jobs/${queue.name}?state=waiting`}
          >
            <Card className="h-full transition-colors hover:bg-muted/50">
              <CardContent className="space-y-3 p-4">
                <div>
                  <h2 className="font-semibold">{queue.label}</h2>
                  <p className="text-sm text-muted-foreground">{queue.description}</p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{queue.name}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <CountBadge label="waiting" value={queue.counts.waiting} />
                  <CountBadge label="active" value={queue.counts.active} />
                  <CountBadge label="failed" value={queue.counts.failed} highlight={queue.counts.failed > 0} />
                  <CountBadge label="completed" value={queue.counts.completed} />
                  <CountBadge label="delayed" value={queue.counts.delayed} />
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
