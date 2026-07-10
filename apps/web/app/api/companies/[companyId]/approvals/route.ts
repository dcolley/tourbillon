import { NextRequest, NextResponse } from 'next/server';
import { db, approvals, issues, activityLog, type IssueStatus } from '@tourbillon/db';
import { and, eq, inArray } from 'drizzle-orm';
import { validateRunToken } from '@/lib/auth/run-token';

type ApprovalPayload = Record<string, unknown> & {
  title?: string;
  summary?: string;
  priorStatuses?: Record<string, IssueStatus>;
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> }
) {
  const { companyId } = await params;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const runCtx = validateRunToken(token);
  if (!runCtx) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  if (runCtx.companyId !== companyId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = (await req.json()) as {
    type: string;
    issueIds?: string[];
    payload: ApprovalPayload;
    requestedByAgentId?: string;
  };

  const issueIds = [...new Set((body.issueIds ?? []).filter(Boolean))];
  const basePayload: ApprovalPayload =
    body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
      ? { ...body.payload }
      : {};

  try {
    const approval = await db.transaction(async (tx) => {
      const priorStatuses: Record<string, IssueStatus> = {};

      if (issueIds.length > 0) {
        const linked = await tx
          .select({
            id: issues.id,
            status: issues.status,
            boardApprovalId: issues.boardApprovalId,
            identifier: issues.identifier,
          })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));

        if (linked.length !== issueIds.length) {
          throw Object.assign(new Error('One or more issueIds were not found in this company'), {
            status: 400,
          });
        }

        const alreadyHalted = linked.find((row) => row.boardApprovalId);
        if (alreadyHalted) {
          throw Object.assign(
            new Error(
              `Issue ${alreadyHalted.identifier} is already halted for board approval ${alreadyHalted.boardApprovalId}`,
            ),
            { status: 409 },
          );
        }

        for (const row of linked) {
          priorStatuses[row.id] = row.status;
        }
      }

      const payload: ApprovalPayload = {
        ...basePayload,
        ...(Object.keys(priorStatuses).length > 0 ? { priorStatuses } : {}),
      };

      const [created] = await tx
        .insert(approvals)
        .values({
          companyId,
          type: body.type,
          status: 'pending',
          requestedByAgentId: body.requestedByAgentId ?? runCtx.agentId,
          issueIds,
          payload,
        })
        .returning();

      if (issueIds.length > 0) {
        const now = new Date();
        await tx
          .update(issues)
          .set({
            status: 'blocked',
            boardApprovalId: created.id,
            checkoutRunId: null,
            executionLockedAt: null,
            executionAgentNameKey: null,
            updatedAt: now,
          })
          .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));

        for (const issueId of issueIds) {
          await tx.insert(activityLog).values({
            companyId,
            actorType: 'agent',
            actorId: runCtx.agentId,
            action: 'issue.updated',
            entityType: 'issue',
            entityId: issueId,
            details: {
              status: 'blocked',
              boardApprovalId: created.id,
              priorStatus: priorStatuses[issueId],
              comment: `Blocked pending board approval (${created.type}).`,
              runId: runCtx.runId,
            },
          });
        }
      }

      return created;
    });

    return NextResponse.json(approval, { status: 201 });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw err;
  }
}
