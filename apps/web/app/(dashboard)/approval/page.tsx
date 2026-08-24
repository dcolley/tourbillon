import Link from 'next/link';
import { db, approvals, agents, issues } from '@tourbillon/db';
import { desc, eq, inArray } from 'drizzle-orm';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { StatusBadge } from '@/lib/status-badges';
import { getActiveCompanyOrNull } from '@/lib/company';

export default async function ApprovalsPage() {
  const company = await getActiveCompanyOrNull();
  if (!company) return null;
  const pendingApprovals = await db
    .select({ approval: approvals, agent: agents })
    .from(approvals)
    .leftJoin(agents, eq(approvals.requestedByAgentId, agents.id))
    .where(eq(approvals.companyId, company.id))
    .orderBy(desc(approvals.createdAt))
    .limit(50);

  const allIssueIds = [
    ...new Set(pendingApprovals.flatMap(({ approval }) => approval.issueIds ?? [])),
  ];
  const linkedIssues =
    allIssueIds.length > 0
      ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            boardApprovalId: issues.boardApprovalId,
          })
          .from(issues)
          .where(inArray(issues.id, allIssueIds))
      : [];
  const issuesById = new Map(linkedIssues.map((row) => [row.id, row]));

  const pending = pendingApprovals.filter((r) => r.approval.status === 'pending');
  const decided = pendingApprovals.filter((r) => r.approval.status !== 'pending');

  return (
    <div className="space-y-6">
      <PageHeader title="Approvals" description="Governance queue — board decisions" />

      {pending.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
            Awaiting Decision ({pending.length})
          </h2>
          <div className="space-y-3">
            {pending.map(({ approval, agent }) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                agent={agent}
                linkedIssues={(approval.issueIds ?? [])
                  .map((id) => issuesById.get(id))
                  .filter((row): row is NonNullable<typeof row> => Boolean(row))}
              />
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
          Recent Decisions
        </h2>
        <Card>
          <CardContent className="p-0">
            {decided.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No decisions yet.</p>
            ) : (
              <div className="divide-y">
                {decided.map(({ approval, agent }) => (
                  <div key={approval.id} className="flex items-center justify-between gap-4 p-4">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {(approval.payload as { title?: string })?.title ?? approval.type}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Requested by {agent?.name ?? 'Unknown'}
                        {(approval.issueIds?.length ?? 0) > 0
                          ? ` · ${approval.issueIds.length} linked issue${approval.issueIds.length === 1 ? '' : 's'}`
                          : ''}
                      </p>
                      {approval.hitlyApprovalId && (
                        <p className="text-xs text-muted-foreground">
                          Sent to HITLy · <span className="font-mono">{approval.hitlyApprovalId}</span>
                        </p>
                      )}
                      {approval.note ? (
                        <p className="mt-1 text-sm text-muted-foreground">{approval.note}</p>
                      ) : null}
                    </div>
                    <StatusBadge status={approval.status} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function ApprovalCard({
  approval,
  agent,
  linkedIssues,
}: {
  approval: {
    id: string;
    type: string;
    payload: unknown;
    createdAt: Date;
    issueIds: string[];
    hitlyApprovalId: string | null;
    hitlyError: string | null;
  };
  agent: { name: string } | null;
  linkedIssues: Array<{
    id: string;
    identifier: string;
    title: string;
    boardApprovalId: string | null;
  }>;
}) {
  const payload = approval.payload as { title?: string; summary?: string };
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-medium">{payload?.title ?? approval.type}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Requested by {agent?.name ?? 'Unknown agent'} ·{' '}
              {new Date(approval.createdAt).toLocaleDateString()}
            </p>
            {approval.hitlyApprovalId && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                Sent to HITLy · <span className="font-mono">{approval.hitlyApprovalId}</span>
              </p>
            )}
            {approval.hitlyError && (
              <p className="mt-0.5 text-xs text-destructive">
                HITLy ingest error: {approval.hitlyError}
              </p>
            )}
          </div>
          <StatusBadge status="pending" />
        </div>
        {payload?.summary && <p className="text-sm text-muted-foreground">{payload.summary}</p>}
        {linkedIssues.length > 0 && (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Halted issues
            </p>
            <ul className="mt-1 space-y-1">
              {linkedIssues.map((issue) => (
                <li key={issue.id}>
                  <Link href={`/issue/${issue.id}`} className="hover:underline">
                    <span className="font-mono text-xs">{issue.identifier}</span>
                    <span className="text-muted-foreground"> — {issue.title}</span>
                    {issue.boardApprovalId === approval.id ? (
                      <span className="ml-2 text-xs text-amber-700">halted</span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        <form action={`/api/approvals/${approval.id}/decide`} method="POST" className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor={`approval-note-${approval.id}`}>Reason</Label>
            <Textarea
              id={`approval-note-${approval.id}`}
              name="note"
              rows={3}
              placeholder="Optional reason (posted to linked issues)"
              className="resize-y"
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" name="decision" value="approved" size="sm">
              Approve
            </Button>
            <Button type="submit" name="decision" value="rejected" size="sm" variant="destructive">
              Reject
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
