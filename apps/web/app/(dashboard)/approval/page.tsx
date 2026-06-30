import { db, approvals, agents } from '@tourbillon/db';
import { desc, eq } from 'drizzle-orm';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StatusBadge } from '@/lib/status-badges';
import { getActiveCompany } from '@/lib/company';

export default async function ApprovalsPage() {
  const company = await getActiveCompany();
  const pendingApprovals = await db
    .select({ approval: approvals, agent: agents })
    .from(approvals)
    .leftJoin(agents, eq(approvals.requestedByAgentId, agents.id))
    .where(eq(approvals.companyId, company.id))
    .orderBy(desc(approvals.createdAt))
    .limit(50);

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
              <ApprovalCard key={approval.id} approval={approval} agent={agent} />
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
                  <div key={approval.id} className="flex items-center justify-between p-4">
                    <div>
                      <p className="text-sm font-medium">
                        {(approval.payload as { title?: string })?.title ?? approval.type}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Requested by {agent?.name ?? 'Unknown'}
                      </p>
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
}: {
  approval: { id: string; type: string; payload: unknown; createdAt: Date };
  agent: { name: string } | null;
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
          </div>
          <StatusBadge status="pending" />
        </div>
        {payload?.summary && <p className="text-sm text-muted-foreground">{payload.summary}</p>}
        <div className="flex gap-2">
          <form action={`/api/approvals/${approval.id}/decide`} method="POST">
            <input type="hidden" name="decision" value="approved" />
            <Button type="submit" size="sm">
              Approve
            </Button>
          </form>
          <form action={`/api/approvals/${approval.id}/decide`} method="POST">
            <input type="hidden" name="decision" value="rejected" />
            <Button type="submit" size="sm" variant="destructive">
              Reject
            </Button>
          </form>
        </div>
      </CardContent>
    </Card>
  );
}
