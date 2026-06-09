import { db, approvals, agents } from '@paperclip-mastra/db';
import { desc, eq } from 'drizzle-orm';

export default async function ApprovalsPage() {
  const pendingApprovals = await db
    .select({ approval: approvals, agent: agents })
    .from(approvals)
    .leftJoin(agents, eq(approvals.requestedByAgentId, agents.id))
    .orderBy(desc(approvals.createdAt))
    .limit(50);

  const pending = pendingApprovals.filter((r) => r.approval.status === 'pending');
  const decided = pendingApprovals.filter((r) => r.approval.status !== 'pending');

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Approvals</h1>
        <p className="text-muted-foreground">Governance queue — board decisions</p>
      </div>

      {pending.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Awaiting Decision ({pending.length})
          </h2>
          <div className="space-y-3">
            {pending.map(({ approval, agent }) => (
              <ApprovalCard key={approval.id} approval={approval} agent={agent} />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Recent Decisions</h2>
        <div className="border rounded-lg divide-y">
          {decided.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">No decisions yet.</p>
          )}
          {decided.map(({ approval, agent }) => (
            <div key={approval.id} className="flex items-center justify-between p-4">
              <div>
                <p className="text-sm font-medium">{(approval.payload as { title?: string })?.title ?? approval.type}</p>
                <p className="text-xs text-muted-foreground">Requested by {agent?.name ?? 'Unknown'}</p>
              </div>
              <span className={`text-xs font-medium ${
                approval.status === 'approved' ? 'text-green-600' : 'text-red-600'
              }`}>
                {approval.status}
              </span>
            </div>
          ))}
        </div>
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
    <div className="border rounded-lg p-4 bg-card space-y-3">
      <div className="flex items-start justify-between">
        <div>
          <p className="font-medium">{payload?.title ?? approval.type}</p>
          <p className="text-sm text-muted-foreground mt-0.5">
            Requested by {agent?.name ?? 'Unknown agent'} ·{' '}
            {new Date(approval.createdAt).toLocaleDateString()}
          </p>
        </div>
        <span className="text-xs text-yellow-600 font-medium bg-yellow-50 px-2 py-0.5 rounded-full">
          Pending
        </span>
      </div>
      {payload?.summary && (
        <p className="text-sm text-muted-foreground">{payload.summary}</p>
      )}
      <div className="flex gap-2">
        <form action={`/api/approvals/${approval.id}/decide`} method="POST">
          <input type="hidden" name="decision" value="approved" />
          <button type="submit" className="text-xs px-3 py-1.5 rounded-md bg-green-600 text-white font-medium hover:bg-green-700">
            Approve
          </button>
        </form>
        <form action={`/api/approvals/${approval.id}/decide`} method="POST">
          <input type="hidden" name="decision" value="rejected" />
          <button type="submit" className="text-xs px-3 py-1.5 rounded-md bg-destructive text-destructive-foreground font-medium hover:bg-destructive/90">
            Reject
          </button>
        </form>
      </div>
    </div>
  );
}
