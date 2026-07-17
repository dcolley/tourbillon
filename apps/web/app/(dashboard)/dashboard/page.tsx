import { db } from '@tourbillon/db';
import { agents, approvals, issues } from '@tourbillon/db';
import { and, eq, count } from 'drizzle-orm';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/lib/status-badges';
import { heartbeatJobHref, listHeartbeatRuns } from '@/lib/heartbeats';
import { getActiveCompanyOrNull } from '@/lib/company';

export default async function DashboardPage() {
  const company = await getActiveCompanyOrNull();
  if (!company) return null;

  const [agentCount] = await db
    .select({ count: count() })
    .from(agents)
    .where(eq(agents.companyId, company.id));
  const [issueCount] = await db
    .select({ count: count() })
    .from(issues)
    .where(eq(issues.companyId, company.id));
  const [activeIssueCount] = await db
    .select({ count: count() })
    .from(issues)
    .where(and(eq(issues.companyId, company.id), eq(issues.status, 'in_progress')));
  const [pendingApprovalCount] = await db
    .select({ count: count() })
    .from(approvals)
    .where(and(eq(approvals.companyId, company.id), eq(approvals.status, 'pending')));

  const recentRuns = await listHeartbeatRuns({ limit: 10 });

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" description="Company overview" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total Agents" value={agentCount.count} />
        <StatCard label="Total Issues" value={issueCount.count} />
        <StatCard label="In Progress" value={activeIssueCount.count} />
        <StatCard
          label="Approvals Pending"
          value={pendingApprovalCount.count}
          href="/approval"
        />
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

function StatCard({
  label,
  value,
  href,
}: {
  label: string;
  value: number;
  href?: string;
}) {
  const content = (
    <>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-bold tracking-tight">{value}</p>
      </CardContent>
    </>
  );

  if (href) {
    return (
      <Link href={href} className="block transition-colors hover:opacity-90">
        <Card className="h-full hover:bg-muted/40">{content}</Card>
      </Link>
    );
  }

  return <Card>{content}</Card>;
}
