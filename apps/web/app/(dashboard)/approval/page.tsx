import Link from 'next/link';
import { db, approvals, agents, issues } from '@tourbillon/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { StatusBadge } from '@/lib/status-badges';
import { getActiveCompanyOrNull } from '@/lib/company';
import { expireDueApprovals } from '@/lib/approval-expiry';
import { ApprovalQuestionCard } from './approval-question-card';
import { prepareCardForBoard } from './approval-data';
import { responseSummary } from './response-summary';

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams?: Promise<{ decideError?: string; for?: string }>;
}) {
  const company = await getActiveCompanyOrNull();
  if (!company) return null;
  const sp = (await searchParams) ?? {};
  // APR-2: lazy expiry sweep before listing (same claim as every decide path).
  await expireDueApprovals(company.id);
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
          .where(and(eq(issues.companyId, company.id), inArray(issues.id, allIssueIds)))
      : [];
  const issuesById = new Map(linkedIssues.map((row) => [row.id, row]));

  const pending = pendingApprovals.filter((r) => r.approval.status === 'pending');
  const decided = pendingApprovals.filter((r) => r.approval.status !== 'pending');
  const linkPaths = new Map<string, Record<string, string>>();
  for (const { approval } of pending) linkPaths.set(approval.id, await prepareCardForBoard(company.id, approval));

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
              <ApprovalQuestionCard
                key={approval.id}
                approval={approval}
                agent={agent}
                linkPaths={linkPaths.get(approval.id) ?? {}}
                error={sp.for === approval.id ? sp.decideError?.slice(0, 300) : undefined}
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
                        <Link href={`/approval/${approval.id}`} className="hover:underline">
                          {(approval.payload as { title?: string })?.title ??
                            (approval.hitlRequest as { question?: string } | null)?.question ??
                            approval.type}
                        </Link>
                      </p>
                      {responseSummary(approval) ? (
                        <p className="text-xs text-muted-foreground">{responseSummary(approval)}</p>
                      ) : null}
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
