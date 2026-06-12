import Link from 'next/link';
import { notFound } from 'next/navigation';
import { QUEUE_HEARTBEAT } from '@tourbillon/shared';
import { heartbeatJobHref } from '@/lib/heartbeats';
import { listGoalOptions } from '@/lib/goals';
import { listProjectOptions } from '@/lib/projects';
import { listIssueComments } from '@/lib/issue-comments';
import { getIssueDetail, listIssueAgentOptions } from '@/lib/issues';
import { commentOnIssueAction, updateIssueAction } from '../actions';
import { IssueCommentsSection } from './issue-comments-section';
import { IssueDetailTabs } from './issue-detail-tabs';
import { IssueEditForm } from './issue-edit-form';
import { IssueExecutionPanel } from './issue-execution-panel';
import { IssueObservabilityTab } from './issue-observability-tab';

export default async function IssueDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ issueId: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { issueId } = await params;
  const { saved } = await searchParams;
  const [detail, agents, goals, projectList] = await Promise.all([
    getIssueDetail(issueId),
    listIssueAgentOptions(),
    listGoalOptions(),
    listProjectOptions(),
  ]);

  const { comments } = detail
    ? await listIssueComments(issueId, detail.issue.companyId, { order: 'desc' })
    : { comments: [] };

  if (!detail) notFound();

  const { issue, assignee, goal, project, activity, heartbeatRuns, heartbeatJobs } = detail;
  const savedFlag = saved === '1';
  const activeJob = heartbeatJobs.find((job) => job.state === 'active') ?? heartbeatJobs[0];

  const observabilityAgents = agents.map((a) => ({ id: a.id, name: a.name }));

  return (
    <div className="max-w-5xl space-y-6 p-6">
      <div>
        <Link
          href="/issue"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          ← Back to issues
        </Link>
        <p className="mt-2 font-mono text-sm text-muted-foreground">{issue.identifier}</p>
        <h1 className="text-2xl font-bold tracking-tight">{issue.title}</h1>
        {goal && (
          <p className="mt-1 text-sm text-muted-foreground">
            Goal:{' '}
            <Link href={`/goal/${goal.id}`} className="text-foreground hover:underline">
              {goal.title}
            </Link>
          </p>
        )}
        {project && (
          <p className="mt-1 text-sm text-muted-foreground">
            Project:{' '}
            <Link href={`/project/${project.id}`} className="text-foreground hover:underline">
              {project.title}
            </Link>
          </p>
        )}
        {assignee && (
          <p className="mt-1 text-sm text-muted-foreground">
            Assigned to{' '}
            <Link href={`/agent/${assignee.urlKey}`} className="text-foreground hover:underline">
              {assignee.name}
            </Link>
          </p>
        )}
      </div>

      <IssueDetailTabs
        overview={
          <>
      {savedFlag && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Changes saved.
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <DetailField label="Status" value={issue.status.replace(/_/g, ' ')} />
        <DetailField label="Priority" value={issue.priority} />
        <DetailField label="Source" value={issue.source} />
        <DetailField label="Created" value={issue.createdAt.toLocaleString()} />
        <DetailField label="Updated" value={issue.updatedAt.toLocaleString()} />
        <DetailField
          label="Checkout"
          value={issue.checkoutRunId ? `Locked (${issue.checkoutRunId.slice(0, 8)}…)` : 'Available'}
        />
      </div>

      <IssueEditForm
        issue={issue}
        agents={agents}
        goals={goals}
        projects={projectList}
        action={updateIssueAction}
      />

      <IssueCommentsSection
        issue={issue}
        agents={agents}
        comments={comments}
        commentAction={commentOnIssueAction}
      />

      <div>
        <h2 className="mb-3 text-lg font-semibold">Activity</h2>
        {activity.length === 0 ? (
          <p className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
            No activity yet.
          </p>
        ) : (
          <div className="rounded-lg border divide-y">
            {activity.map((entry) => (
              <div key={entry.id} className="flex items-start justify-between gap-4 p-4">
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium">{formatAction(entry.action)}</p>
                  <p className="text-sm text-muted-foreground capitalize">
                    {entry.actorType}
                    {entry.actorName ? ` · ${entry.actorName}` : ''}
                  </p>
                  {hasDetails(entry.details) && (
                    <p className="break-all font-mono text-xs text-muted-foreground">
                      {summarizeDetails(
                        entry.action,
                        entry.details as Record<string, unknown>,
                        entry.actorName
                      )}
                    </p>
                  )}
                </div>
                <time
                  dateTime={entry.createdAt.toISOString()}
                  className="shrink-0 text-xs text-muted-foreground"
                >
                  {formatRelativeTime(entry.createdAt)}
                </time>
              </div>
            ))}
          </div>
        )}
      </div>

      {heartbeatRuns.length > 0 && (
        <div>
          <h2 className="mb-3 text-lg font-semibold">Heartbeat runs</h2>
          <div className="rounded-lg border divide-y">
            {heartbeatRuns.map((run) => {
              const href = heartbeatJobHref(run);
              const row = (
                <div className="flex items-center justify-between gap-4 p-4">
                  <div className="min-w-0 space-y-1">
                    <p className="font-mono text-xs text-muted-foreground">{run.id}</p>
                    <p className="text-sm capitalize">
                      {run.status} · {run.invocationSource.replace(/_/g, ' ')}
                    </p>
                    {run.errorText && (
                      <p className="truncate text-xs text-destructive">{run.errorText}</p>
                    )}
                  </div>
                  <time className="shrink-0 text-xs text-muted-foreground">
                    {run.startedAt.toLocaleString()}
                  </time>
                </div>
              );
              return href ? (
                <Link
                  key={run.id}
                  href={href}
                  className="block hover:bg-accent/50 transition-colors"
                >
                  {row}
                </Link>
              ) : (
                <div key={run.id}>{row}</div>
              );
            })}
          </div>
        </div>
      )}

      {activeJob && (
        <IssueExecutionPanel
          queue={QUEUE_HEARTBEAT}
          jobId={activeJob.id}
          jobState={activeJob.state}
        />
      )}

      {heartbeatJobs.length > 0 && (
        <div>
          <h2 className="mb-2 text-lg font-semibold">Related jobs</h2>
          <div className="rounded-lg border divide-y">
            {heartbeatJobs.map((job) => (
              <Link
                key={job.id}
                href={`/jobs/${QUEUE_HEARTBEAT}/${job.id}?state=${job.state}`}
                className="flex items-center justify-between gap-4 p-3 hover:bg-accent/50 transition-colors"
              >
                <span className="font-mono text-xs">{job.id}</span>
                <span className="text-sm capitalize text-muted-foreground">{job.state}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
          </>
        }
        observability={
          <IssueObservabilityTab issueId={issueId} agents={observabilityAgents} />
        }
      />
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-medium capitalize">{value}</p>
    </div>
  );
}

function hasDetails(details: unknown): details is Record<string, unknown> {
  return (
    details !== null &&
    typeof details === 'object' &&
    Object.keys(details as object).length > 0
  );
}

function formatAction(action: string): string {
  const labels: Record<string, string> = {
    'issue.checked_out': 'Issue checked out',
    'issue.updated': 'Issue updated',
    'issue.created': 'Issue created',
  };
  return labels[action] ?? action.replace(/\./g, ' · ').replace(/_/g, ' ');
}

function summarizeDetails(
  action: string,
  details: Record<string, unknown>,
  actorName?: string | null
): string {
  if (action === 'issue.created') {
    const createdBy = details.createdBy ?? actorName ?? 'unknown';
    const parts = [`created by ${createdBy}`];
    if (details.identifier) parts.push(String(details.identifier));
    if (details.source) parts.push(`source: ${details.source}`);
    return parts.join(' · ');
  }

  const parts: string[] = [];
  if (details.status) parts.push(`status → ${details.status}`);
  if (details.priority) parts.push(`priority → ${details.priority}`);
  if (details.title) parts.push(`title → ${details.title}`);
  if (details.comment) parts.push(String(details.comment));
  if (details.assigneeAgentId !== undefined) {
    parts.push(details.assigneeAgentId ? 'assignee changed' : 'unassigned');
  }
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
