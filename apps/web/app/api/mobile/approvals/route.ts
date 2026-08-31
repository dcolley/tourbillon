import { NextRequest, NextResponse } from 'next/server';
import { db, approvals, agents, issues } from '@tourbillon/db';
import { desc, eq, inArray } from 'drizzle-orm';
import { requireMobileCompany, toJson } from '@/lib/mobile-session';

export async function listCompanyApprovals(companyId: string) {
  const rows = await db
    .select({ approval: approvals, agent: agents })
    .from(approvals)
    .leftJoin(agents, eq(approvals.requestedByAgentId, agents.id))
    .where(eq(approvals.companyId, companyId))
    .orderBy(desc(approvals.createdAt))
    .limit(50);

  const allIssueIds = [...new Set(rows.flatMap(({ approval }) => approval.issueIds ?? []))];
  const linkedIssues =
    allIssueIds.length > 0
      ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            boardApprovalId: issues.boardApprovalId,
          })
          .from(issues)
          .where(inArray(issues.id, allIssueIds))
      : [];
  const issuesById = new Map(linkedIssues.map((row) => [row.id, row]));

  return rows.map(({ approval, agent }) => ({
    ...approval,
    requester: agent ? { id: agent.id, name: agent.name, urlKey: agent.urlKey } : null,
    linkedIssues: (approval.issueIds ?? [])
      .map((id) => issuesById.get(id))
      .filter((row): row is NonNullable<typeof row> => Boolean(row)),
  }));
}

export async function GET(req: NextRequest) {
  const auth = await requireMobileCompany(req);
  if ('error' in auth) return auth.error;

  try {
    const list = await listCompanyApprovals(auth.company.id);
    return NextResponse.json({ approvals: toJson(list) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list approvals';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
