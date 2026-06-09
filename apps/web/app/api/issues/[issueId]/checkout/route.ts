import { NextRequest, NextResponse } from 'next/server';
import { db, issues, activityLog } from '@tourbillon/db';
import { eq, and, inArray } from 'drizzle-orm';
import { validateRunToken } from '@/lib/auth/run-token';
import { logAgentApiRequest, logAgentApiResponse, summarizeBody } from '@/lib/agent-api-trace';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ issueId: string }> }
) {
  const { issueId } = await params;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const runCtx = validateRunToken(token);
  if (!runCtx) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

  const runId = req.headers.get('x-paperclip-run-id');
  const body = await req.json() as { agentId: string; expectedStatuses: string[] };

  logAgentApiRequest(`/api/issues/${issueId}/checkout`, 'POST', runCtx, {
    issueId: issueId,
    headerRunId: runId,
    body: summarizeBody(body),
  });

  // Atomic checkout via DB transaction
  try {
    const result = await db.transaction(async (tx) => {
      const issue = await tx.query.issues.findFirst({
        where: eq(issues.id, issueId),
      });

      if (!issue) throw Object.assign(new Error('Not found'), { status: 404 });
      if (issue.companyId !== runCtx.companyId) throw Object.assign(new Error('Forbidden'), { status: 403 });

      // Check if already locked by a DIFFERENT run
      if (issue.checkoutRunId && issue.checkoutRunId !== runId) {
        throw Object.assign(new Error('Conflict: already checked out'), { status: 409 });
      }

      // Check expected statuses
      if (body.expectedStatuses && !body.expectedStatuses.includes(issue.status)) {
        throw Object.assign(new Error(`Issue status is ${issue.status}, not in expected ${body.expectedStatuses.join(',')}`), { status: 409 });
      }

      // Acquire lock
      const [updated] = await tx
        .update(issues)
        .set({
          checkoutRunId: runId,
          executionLockedAt: new Date(),
          executionAgentNameKey: runCtx.agentId,
          status: 'in_progress',
          startedAt: issue.startedAt ?? new Date(),
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issueId))
        .returning();

      await tx.insert(activityLog).values({
        companyId: runCtx.companyId,
        actorType: 'agent',
        actorId: runCtx.agentId,
        action: 'issue.checked_out',
        entityType: 'issue',
        entityId: issueId,
        details: { runId, previousStatus: issue.status },
      });

      return updated;
    });

    logAgentApiResponse(`/api/issues/${issueId}/checkout`, 'POST', runCtx, 200, {
      issueId: issueId,
      identifier: result.identifier,
      status: result.status,
      checkoutRunId: result.checkoutRunId,
    });
    return NextResponse.json(result);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    const status = e.status ?? 500;
    logAgentApiResponse(`/api/issues/${issueId}/checkout`, 'POST', runCtx, status, {
      issueId: issueId,
      error: e.message,
    });
    return NextResponse.json({ error: e.message }, { status });
  }
}
