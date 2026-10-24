/**
 * APR-2: one approval, for the Board. Company-scoped: another company's approval is 404.
 * Pending: the answer card (records `presented`). Decided: the stored `hitl/response/v0`
 * (status, answer, reason, decided by, activity) next to the request.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db, approvals, agents, issues } from '@tourbillon/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { HitlRequest, HitlResponse } from '@tourbillon/shared/hitl';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getActiveCompanyOrNull } from '@/lib/company';
import { expireApprovalIfDue } from '@/lib/approval-expiry';
import { loadHitlEvents } from '@/lib/hitl-host';
import { StatusBadge } from '@/lib/status-badges';
import { ApprovalQuestionCard } from '../approval-question-card';
import { prepareCardForBoard } from '../approval-data';
import { responseSummary } from '../response-summary';

export default async function ApprovalDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ approvalId: string }>;
  searchParams?: Promise<{ decideError?: string; for?: string }>;
}) {
  const { approvalId } = await params;
  const sp = (await searchParams) ?? {};
  const company = await getActiveCompanyOrNull();
  if (!company) notFound();

  await expireApprovalIfDue(company.id, approvalId);
  const [row] = await db
    .select({ approval: approvals, agent: agents })
    .from(approvals)
    .leftJoin(agents, eq(approvals.requestedByAgentId, agents.id))
    .where(and(eq(approvals.id, approvalId), eq(approvals.companyId, company.id)))
    .limit(1);
  if (!row) notFound();
  const { approval, agent } = row;

  const linkPaths = await prepareCardForBoard(company.id, approval);
  const current =
    approval.status === 'pending' && !approval.presentedAt
      ? ((await db.query.approvals.findFirst({ where: and(eq(approvals.id, approvalId), eq(approvals.companyId, company.id)) })) ?? approval)
      : approval;
  const linkedIssues =
    (current.issueIds ?? []).length > 0
      ? await db
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title, boardApprovalId: issues.boardApprovalId })
          .from(issues)
          .where(and(eq(issues.companyId, company.id), inArray(issues.id, current.issueIds)))
      : [];
  const events = await loadHitlEvents(db, company.id, approvalId);
  const req = current.hitlRequest as HitlRequest | null;
  const response = current.hitlResponse as HitlResponse | null;
  const payload = (current.payload ?? {}) as { title?: string };

  return (
    <div className="space-y-6">
      <PageHeader
        title={req?.question ?? payload.title ?? current.type}
        description={`Approval · ${current.type}`}
      />
      <p className="text-sm">
        <Link href="/approval" className="text-muted-foreground hover:underline">
          ← All approvals
        </Link>
      </p>

      <ApprovalQuestionCard
        approval={current}
        agent={agent}
        linkedIssues={linkedIssues}
        linkPaths={linkPaths}
        returnTo={`/approval/${approvalId}`}
        error={sp.for === approvalId ? sp.decideError?.slice(0, 300) : undefined}
        showDetailsLink={false}
      />

      {response ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              Response <StatusBadge status={current.status} />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>{responseSummary(current)}</p>
            {response.reason ? <p className="text-muted-foreground">Reason: {response.reason}</p> : null}
            {response.decidedAt ? (
              <p className="text-xs text-muted-foreground">Decided at {response.decidedAt}</p>
            ) : response.status === 'expired' ? (
              <p className="text-xs text-muted-foreground">Expired with no answer; the requesting agent was told.</p>
            ) : null}
            {response.argsHash ? (
              <p className="text-xs text-muted-foreground">
                Bound to action {req?.action?.name ?? ''} · argsHash <code>{response.argsHash}</code>
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Activity</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {events.length === 0 ? (
            <p className="text-muted-foreground">No reviewer activity recorded yet.</p>
          ) : (
            <ol className="space-y-1">
              {events.map((e) => (
                <li key={e.id} className="flex gap-3">
                  <time className="font-mono text-xs text-muted-foreground" dateTime={e.at.toISOString()}>
                    {e.at.toISOString().replace('T', ' ').slice(0, 19)} UTC
                  </time>
                  <span>
                    {e.type}
                    {e.itemRef ? ` · ${e.itemRef}` : ''} · {e.actorKind}:{e.actorId}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Events are hash-chained and included in the response the requesting agent receives.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
