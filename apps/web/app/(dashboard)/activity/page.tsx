import { db, activityLog } from '@tourbillon/db';
import { desc } from 'drizzle-orm';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';

export default async function ActivityPage() {
  const entries = await db
    .select()
    .from(activityLog)
    .orderBy(desc(activityLog.createdAt))
    .limit(100);

  return (
    <div className="space-y-6">
      <PageHeader title="Activity" description="Audit log of agent and system actions" />

      <Card>
        <CardContent className="p-0">
          {entries.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              No activity yet. Actions like issue checkouts and updates will appear here.
            </p>
          ) : (
            <div className="divide-y">
              {entries.map((entry) => (
                <div key={entry.id} className="flex items-start justify-between gap-4 p-4 text-sm">
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium">{formatAction(entry.action)}</p>
                    <p className="text-muted-foreground">
                      <span className="capitalize">{entry.actorType}</span>
                      {entry.actorName ? ` · ${entry.actorName}` : ''}
                      {' · '}
                      <span className="font-mono text-xs">{entry.entityType}</span>
                      <span className="font-mono text-xs">/{entry.entityId.slice(0, 8)}…</span>
                    </p>
                    {entry.details != null &&
                    typeof entry.details === 'object' &&
                    Object.keys(entry.details as object).length > 0 ? (
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {summarizeDetails(entry.details as Record<string, unknown>)}
                      </p>
                    ) : null}
                  </div>
                  <time
                    className="shrink-0 text-xs text-muted-foreground"
                    dateTime={entry.createdAt.toISOString()}
                  >
                    {formatRelativeTime(entry.createdAt)}
                  </time>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function formatAction(action: string): string {
  const labels: Record<string, string> = {
    'issue.checked_out': 'Issue checked out',
    'issue.updated': 'Issue updated',
    'issue.created': 'Issue created',
    'agent.created': 'Agent hired',
    'approval.created': 'Approval requested',
    'approval.decided': 'Approval decided',
  };
  return labels[action] ?? action.replace(/\./g, ' · ').replace(/_/g, ' ');
}

function summarizeDetails(details: Record<string, unknown>): string {
  const parts: string[] = [];
  if (details.status) parts.push(`status → ${details.status}`);
  if (details.comment) parts.push('comment added');
  if (details.runId) parts.push(`run ${String(details.runId).slice(0, 8)}…`);
  return parts.join(', ') || JSON.stringify(details);
}

function formatRelativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}
