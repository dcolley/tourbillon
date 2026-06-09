import { db } from '@tourbillon/db';
import { agents, issues } from '@tourbillon/db';
import { eq, count } from 'drizzle-orm';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/lib/status-badges';
import { heartbeatJobHref, listHeartbeatRuns } from '@/lib/heartbeats';

export default async function DashboardPage() {
  const [agentCount] = await db.select({ count: count() }).from(agents);
  const [issueCount] = await db.select({ count: count() }).from(issues);
  const [activeIssueCount] = await db
    .select({ count: count() })
    .from(issues)
    .where(eq(issues.status, 'in_progress'));

  const recentRuns = await listHeartbeatRuns({ limit: 10 });

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" description="Company overview" />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Total Agents" value={agentCount.count} />
        <StatCard label="Total Issues" value={issueCount.count} />
        <StatCard label="In Progress" value={activeIssueCount.count} />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Recent Heartbeats</h2>
          {recentRuns.length > 0 && (
            <Button variant="ghost" size="sm" render={<Link href="/jobs/heartbeat" />}>
              View all
            </Button>
          )}
        </div>
        <Card>
          <CardContent className="p-0">
            {recentRuns.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No heartbeats yet.</p>
            ) : (
              <div className="divide-y">
                {recentRuns.map(({ run, agent }) => (
                  <Link
                    key={run.id}
                    href={heartbeatJobHref(run) ?? `/heartbeat/${run.id}`}
                    className="flex items-center justify-between p-4 text-sm transition-colors hover:bg-muted/50"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <p className="truncate font-medium">
                        {agent?.name ?? `${run.agentId.slice(0, 16)}…`}
                      </p>
                      <p className="font-mono text-xs text-muted-foreground">{run.id.slice(0, 8)}…</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-xs text-muted-foreground">{run.invocationSource}</span>
                      <StatusBadge status={run.status} />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-bold tracking-tight">{value}</p>
      </CardContent>
    </Card>
  );
}
