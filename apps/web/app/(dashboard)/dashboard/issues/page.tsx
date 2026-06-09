import { db, issues, agents } from '@paperclip-mastra/db';
import { desc, eq } from 'drizzle-orm';

const STATUS_COLUMNS = ['todo', 'in_progress', 'in_review', 'done', 'blocked'] as const;

export default async function IssuesPage() {
  const allIssues = await db
    .select({ issue: issues, agent: agents })
    .from(issues)
    .leftJoin(agents, eq(issues.assigneeAgentId, agents.id))
    .orderBy(desc(issues.updatedAt))
    .limit(100);

  const byStatus = STATUS_COLUMNS.reduce((acc, s) => {
    acc[s] = allIssues.filter((r) => r.issue.status === s);
    return acc;
  }, {} as Record<string, typeof allIssues>);

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Issues</h1>
        <p className="text-muted-foreground">All tasks across all agents</p>
      </div>
      <div className="flex gap-4 overflow-x-auto pb-4">
        {STATUS_COLUMNS.map((status) => (
          <div key={status} className="w-72 shrink-0">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold capitalize">{status.replace('_', ' ')}</h3>
              <span className="text-xs text-muted-foreground">{byStatus[status]?.length ?? 0}</span>
            </div>
            <div className="space-y-2">
              {(byStatus[status] ?? []).map(({ issue, agent }) => (
                <div key={issue.id} className="border rounded-lg p-3 bg-card space-y-1.5 hover:shadow-sm transition-shadow">
                  <p className="text-xs font-mono text-muted-foreground">{issue.identifier}</p>
                  <p className="text-sm font-medium leading-snug">{issue.title}</p>
                  {agent && (
                    <p className="text-xs text-muted-foreground">{agent.name}</p>
                  )}
                  <PriorityBadge priority={issue.priority} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  const styles: Record<string, string> = {
    critical: 'text-red-600', high: 'text-orange-500',
    medium: 'text-yellow-500', low: 'text-blue-400',
  };
  const icons: Record<string, string> = {
    critical: '‼️', high: '↑', medium: '—', low: '↓',
  };
  return (
    <span className={`text-xs font-medium ${styles[priority] ?? ''}`}>
      {icons[priority] ?? ''} {priority}
    </span>
  );
}
