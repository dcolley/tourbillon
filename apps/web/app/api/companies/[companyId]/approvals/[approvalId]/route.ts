import { NextRequest, NextResponse } from 'next/server';
import { db, approvals, agents, issues, companies } from '@tourbillon/db';
import { and, eq, inArray } from 'drizzle-orm';
import { authenticateAgentToken } from '@/lib/auth/agent-token-auth';
import { companySettingsSecretValues, serializeApproval } from '@/lib/approval-serializer';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string; approvalId: string }> }
) {
  const { companyId, approvalId } = await params;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const runCtx = await authenticateAgentToken(token);
  if (!runCtx) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  if (runCtx.companyId !== companyId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    // Direct DB lookup by id and companyId
    const rows = await db
      .select({ approval: approvals, agent: agents })
      .from(approvals)
      .leftJoin(agents, eq(approvals.requestedByAgentId, agents.id))
      .where(and(eq(approvals.id, approvalId), eq(approvals.companyId, companyId)))
      .limit(1);

    if (rows.length === 0) {
      return NextResponse.json({ error: 'Approval not found' }, { status: 404 });
    }

    const { approval, agent } = rows[0];

    // Fetch linked issues
    const linkedIssues =
      approval.issueIds.length > 0
        ? await db
            .select({
              id: issues.id,
              identifier: issues.identifier,
              title: issues.title,
              status: issues.status,
              boardApprovalId: issues.boardApprovalId,
            })
            .from(issues)
            .where(inArray(issues.id, approval.issueIds))
        : [];
    const issuesById = new Map(linkedIssues.map((row) => [row.id, row]));

    // Build response with full detail
    const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
    const result = {
      ...serializeApproval(approval, { knownSecrets: companySettingsSecretValues(company?.settings) }),
      requester: agent ? { id: agent.id, name: agent.name, urlKey: agent.urlKey } : null,
      linkedIssues: approval.issueIds
        .map((id) => issuesById.get(id))
        .filter((row): row is NonNullable<typeof row> => Boolean(row)),
    };

    return NextResponse.json({ approval: result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to fetch approval';
    console.error('[GET /approvals/:id] error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
