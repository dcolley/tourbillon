import Link from 'next/link';
import { notFound } from 'next/navigation';
import { heartbeatJobHref } from '@/lib/heartbeats';
import { listGoalOptions } from '@/lib/goals';
import { listProjectOptions } from '@/lib/projects';
import { listIssueComments } from '@/lib/issue-comments';
import { getIssueDetail, listIssueAgentOptions } from '@/lib/issues';
import { commentOnIssueAction, updateIssueAction, updateIssueDescriptionAction, releaseCheckoutLockAction } from '../actions';
import { IssueCommentsSection } from './issue-comments-section';
import { IssueDescriptionSection } from './issue-description-section';
import { IssueDetailTabs } from './issue-detail-tabs';
import { IssueEditForm } from './issue-edit-form';
import { IssueExecutionPanel } from './issue-execution-panel';
import { IssueObservabilityTab } from './issue-observability-tab';
import { DeepLinkCompanySync } from '@/components/deep-link-company-sync';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getCompanyById } from '@/lib/company';
import { STICKY_TOOLBAR_ROOT_ATTR } from '@/lib/sticky-toolbar';

export default async function IssueDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ issueId: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { issueId } = await params;
  const { saved } = await searchParams;
  const detail = await getIssueDetail(issueId);
  if (!detail) notFound();

  const companyId = detail.issue.companyId;
  const [agents, goals, projectList] = await Promise.all([
    listIssueAgentOptions(companyId),
    listGoalOptions(false, companyId),
    listProjectOptions(undefined, companyId),
  ]);

  const { comments } = await listIssueComments(issueId, companyId, { order: 'desc' });

  const { issue, assignee, goal, project, activity, heartbeatRuns, heartbeatJobs } = detail;
  const company = await getCompanyById(companyId);
  const savedFlag = saved === '1';
  const activeJob = heartbeatJobs.find((job) => job.state === 'active') ?? heartbeatJobs[0];
  const holdingRun = issue.checkoutRunId
    ? heartbeatRuns.find((r) => r.id === issue.checkoutRunId)
    : undefined;
  const holdingRunHref = issue.checkoutRunId
    ? holdingRun
      ? (heartbeatJobHref(holdingRun) ?? `/heartbeat/${holdingRun.id}`)
      : `/heartbeat/${issue.checkoutRunId}`
    : null;

  const observabilityAgents = agents.map((a) => ({ id: a.id, name: a.name }));

  return (
    <div {...{ [STICKY_TOOLBAR_ROOT_ATTR]: '' }}>
      <IssueDetailTabs
        identifier={issue.identifier}
        title={issue.title}
        overview={
          <>
      {company ? (
        <DeepLinkCompanySync
          requiredCompanyId={company.id}
          requiredCompanyName={company.name}
        />
      ) : null}

      {(goal || project || assignee) && (
        <div className="space-y-1 text-sm text-muted-foreground">
          {goal && (
            <p>
              Goal:{' '}
              <Link href={`/goal/${goal.id}`} className="text-foreground hover:underline">
                {goal.title}
              </Link>
            </p>
          )}
          {project && (
            <p>
              Project:{' '}
              <Link href={`/project/${project.id}`} className="text-foreground hover:underline">
                {project.title}
              </Link>
            </p>
          )}
          {assignee && (
            <p>
              Assigned to{' '}
              <Link href={`/agent/${assignee.urlKey}`} className="text-foreground hover:underline">
                {assignee.name}
              </Link>
            </p>
          )}
        </div>
      )}

      {savedFlag && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Changes saved.
        </div>
      )}

      {issue.boardApprovalId && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <p className="font-medium">Pending board approval</p>
          <p className="mt-1 text-amber-900">
            This issue is halted until the board decides.{' '}
            <Link href="/approval" className="underline underline-offset-2 hover:text-amber-800">
              Open approvals
            </Link>
            <span className="ml-1 font-mono text-xs text-amber-800">
              ({issue.boardApprovalId.slice(0, 8)}…)
            </span>
          </p>
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
            <DetailField label="Status" value={issue.status.replace(/_/g, ' ')} />
            <DetailField label="Priority" value={issue.priority} />
            <DetailField label="Source" value={issue.source} />
            <DetailField label="Created" value={issue.createdAt.toLocaleString()} />
            <DetailField label="Updated" value={issue.updatedAt.toLocaleString()} />
            <DetailField
              label="Checkout"
              value={
                issue.checkoutRunId
                  ? `Locked (${issue.checkoutRunId.slice(0, 8)}…${
                      holdingRun ? ` · run ${holdingRun.status}` : ' · stale?'
                    })`
                  : 'Available'
              }
            />
          </div>
        </CardContent>
      </Card>

      <IssueDescriptionSection
        issueId={issue.id}
        description={issue.description}
        action={updateIssueDescriptionAction}
      />

      {issue.checkoutRunId && (
        <form action={releaseCheckoutLockAction} className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <input type="hidden" name="issueId" value={issue.id} />
          <p className="text-sm text-amber-900">
            This issue is checked out by{' '}
            {holdingRunHref ? (
              <Link
                href={holdingRunHref}
                className="font-mono text-amber-950 underline underline-offset-2 hover:text-amber-800"
              >
                heartbeat run {issue.checkoutRunId.slice(0, 8)}…
              </Link>
            ) : (
              <span className="font-mono">heartbeat run {issue.checkoutRunId.slice(0, 8)}…</span>
            )}
            {holdingRun ? ` (${holdingRun.status})` : ' (run not found — likely stale)'}.
            Agents will get 409 on checkout until the lock is released.
          </p>
          <button
            type="submit"
            className="mt-2 inline-flex items-center justify-center rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-amber-100"
          >
            Release checkout lock
          </button>
        </form>
      )}

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
          queue="heartbeat"
          jobId={activeJob.id}
          jobState={activeJob.state}
        />
      )}

      {heartbeatJobs.length > 0 && (
        <div>
          <h2 className="mb-2 text-lg font-semibold">Related wakes</h2>
          <div className="rounded-lg border divide-y">
            {heartbeatJobs.map((job) => (
              <Link
                key={job.id}
                href={`/heartbeat/${job.id}`}
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
    <div>
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
