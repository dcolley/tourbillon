import { db } from '@paperclip-mastra/db';
import { agents, issues, heartbeatRuns } from '@paperclip-mastra/db';
import { eq, count, desc } from 'drizzle-orm';
import Link from 'next/link';

export default async function DashboardPage() {
  const [agentCount] = await db.select({ count: count() }).from(agents);
  const [issueCount] = await db.select({ count: count() }).from(issues);
  const [activeIssueCount] = await db
    .select({ count: count() })
    .from(issues)
    .where(eq(issues.status, 'in_progress'));

  const recentRuns = await db
    .select()
    .from(heartbeatRuns)
    .orderBy(desc(heartbeatRuns.startedAt))
    .limit(10);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">Company overview</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Total Agents" value={agentCount.count} />
        <StatCard label="Total Issues" value={issueCount.count} />
        <StatCard label="In Progress" value={activeIssueCount.count} />
      </div>

      {/* Recent heartbeat runs */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Recent Heartbeats</h2>
        <div className="border rounded-lg divide-y">
          {recentRuns.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No heartbeats yet.</p>
          ) : recentRuns.map((run) => (
            <div key={run.id} className="flex items-center justify-between p-3 text-sm">
              <div className="space-y-0.5">
                <p className="font-mono text-xs text-muted-foreground">{run.id.slice(0, 8)}...</p>
                <p className="font-medium">{run.agentId.slice(0, 16)}...</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">{run.invocationSource}</span>
                <StatusBadge status={run.status} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="border rounded-lg p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-3xl font-bold mt-1">{value}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    succeeded: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
    running: 'bg-blue-100 text-blue-700',
    queued: 'bg-yellow-100 text-yellow-700',
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles[status] ?? 'bg-muted text-muted-foreground'}`}>
      {status}
    </span>
  );
}
