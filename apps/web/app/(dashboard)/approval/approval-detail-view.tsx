import type { ReactNode } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/lib/status-badges';
import type { ApprovalDetail, ApprovalHistoryEvent } from '@/lib/approval-detail';
import { approvalDetailHref } from '@/lib/approval-links';
import { ApprovalDecisionForm } from './approval-decision-form';

/**
 * Approval details view. `detail` comes from loadApprovalDetail, already redacted in every field
 * (lib/approval-redaction); this component renders nothing else from the database.
 */
export function ApprovalDetailView({
  detail,
  reasonRequired = false,
}: {
  detail: ApprovalDetail;
  /** Show the "a reason is required to reject" alert (decide route 303 with error=reason_required). */
  reasonRequired?: boolean;
}) {
  const { approval, requester, decidedBy, linkedIssues, missingIssueIds, history, relatedApprovals } = detail;
  const pending = approval.status === 'pending';
  const noteLabel = approval.status === 'rejected' ? 'Board feedback' : 'Board decision note';

  return (
    <div className="space-y-6">
      <div className="text-sm text-muted-foreground">
        <Link href="/approval" className="hover:underline">
          ← Approvals
        </Link>
      </div>

      <PageHeader
        title={approval.title}
        description={approval.summary ?? undefined}
        actions={<StatusBadge status={approval.status} />}
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
            <Field label="Type">
              <span className="font-mono text-sm">{approval.type}</span>
            </Field>
            <Field label="Requested by">
              {requester ? (
                <Link href={`/agent/${encodeURIComponent(requester.urlKey)}`} className="hover:underline">
                  {requester.name}
                </Link>
              ) : (
                'Unknown agent'
              )}
            </Field>
            <Field label="Created">
              <Time value={approval.createdAt} />
            </Field>
            <Field label="Decided">{approval.decidedAt ? <Time value={approval.decidedAt} /> : '—'}</Field>
            <Field label="Decided by">{decidedBy ?? '—'}</Field>
            <Field label="Approval ID">
              <span className="font-mono text-xs break-all">{approval.id}</span>
            </Field>
            {approval.hitlyApprovalId ? (
              <Field label="HITLy">
                <span className="font-mono text-xs break-all">{approval.hitlyApprovalId}</span>
              </Field>
            ) : null}
          </div>
          {approval.hitlyError ? (
            <p className="text-sm text-destructive">HITLy ingest error: {approval.hitlyError}</p>
          ) : null}
          <div>
            <p className="text-xs text-muted-foreground">{noteLabel}</p>
            {approval.note ? (
              <p
                className={
                  approval.status === 'rejected'
                    ? 'mt-1 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm whitespace-pre-wrap break-words'
                    : 'mt-1 text-sm whitespace-pre-wrap break-words'
                }
              >
                {approval.note}
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">{pending ? 'Not decided yet.' : 'No note.'}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {pending ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Decision</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {reasonRequired ? (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                A reason is required to reject. It is sent to the requesting agent as Board feedback.
              </p>
            ) : null}
            <ApprovalDecisionForm approvalId={approval.id} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Linked issues</CardTitle>
        </CardHeader>
        <CardContent>
          {linkedIssues.length === 0 && missingIssueIds.length === 0 ? (
            <p className="text-sm text-muted-foreground">No linked issues.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {linkedIssues.map((issue) => (
                <li key={issue.id}>
                  <Link href={`/issue/${encodeURIComponent(issue.id)}`} className="hover:underline">
                    <span className="font-mono text-xs">{issue.identifier}</span>
                    <span className="text-muted-foreground"> — {issue.title}</span>
                  </Link>
                  <span className="ml-2 text-xs text-muted-foreground">{issue.status.replace(/_/g, ' ')}</span>
                  {issue.haltedByThis ? <span className="ml-2 text-xs text-amber-700">halted</span> : null}
                </li>
              ))}
              {missingIssueIds.map((id) => (
                <li key={id} className="text-muted-foreground">
                  <span className="font-mono text-xs">{id}</span> (issue not found)
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {relatedApprovals.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Related approvals on this issue</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {relatedApprovals.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <Link href={approvalDetailHref(r.id)} className="hover:underline">
                    {r.title}
                  </Link>
                  <StatusBadge status={r.status} />
                  <span className="text-xs text-muted-foreground">
                    <Time value={r.createdAt} />
                    {' · '}
                    {r.sharedIssueIds
                      .map((id) => linkedIssues.find((i) => i.id === id)?.identifier ?? id.slice(0, 8))
                      .join(', ')}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Request payload</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="max-h-[32rem] overflow-auto rounded-md bg-muted/40 p-3 text-xs whitespace-pre-wrap break-words">
            {JSON.stringify(approval.payload, null, 2)}
          </pre>
          <p className="mt-2 text-xs text-muted-foreground">
            Secrets are shown as [redacted].
            {approval.payloadTruncated ? ' Large or deeply nested parts are cut for display ([truncated: …]).' : null}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">History</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3">
            {history.map((event, i) => (
              <HistoryItem key={i} event={event} fallbackAt={approval.createdAt} />
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1 text-sm font-medium">{children}</div>
    </div>
  );
}

function Time({ value }: { value: Date }) {
  return <time dateTime={value.toISOString()}>{value.toLocaleString()}</time>;
}

function HistoryItem({ event, fallbackAt }: { event: ApprovalHistoryEvent; fallbackAt: Date }) {
  return (
    <li className="border-l-2 pl-3 text-sm">
      <p className="text-xs text-muted-foreground">
        {event.at ? <Time value={event.at} /> : <span>after <Time value={fallbackAt} /></span>} · {event.actor}
      </p>
      <p className="mt-0.5">
        {event.issue ? (
          <Link href={`/issue/${encodeURIComponent(event.issue.id)}`} className="hover:underline">
            {event.text}
          </Link>
        ) : (
          event.text
        )}
      </p>
      {event.note && event.noteLabel === 'Board feedback' ? (
        <div className="mt-1 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-destructive">Board feedback</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words">{event.note}</p>
        </div>
      ) : event.note ? (
        <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{event.note}</p>
      ) : null}
    </li>
  );
}
