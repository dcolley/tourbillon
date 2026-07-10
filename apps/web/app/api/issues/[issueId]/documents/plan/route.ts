import { NextRequest, NextResponse } from 'next/server';
import { db, issues } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { validateRunToken } from '@/lib/auth/run-token';
import { logAgentApiRequest, logAgentApiResponse, summarizeBody } from '@/lib/agent-api-trace';

const putPlanSchema = z.object({
  title: z.string().optional().default('Plan'),
  format: z.enum(['markdown']).optional().default('markdown'),
  body: z.string().min(1),
  baseRevisionId: z.string().nullable().optional().default(null),
});

function planPayload(issue: {
  id: string;
  planDocumentBody: string | null;
  planDocumentRevisionId: string | null;
  planDocumentUpdatedAt: Date | null;
}) {
  if (!issue.planDocumentBody || !issue.planDocumentRevisionId) {
    return null;
  }
  return {
    issueId: issue.id,
    title: 'Plan',
    format: 'markdown' as const,
    body: issue.planDocumentBody,
    revisionId: issue.planDocumentRevisionId,
    updatedAt: issue.planDocumentUpdatedAt?.toISOString() ?? null,
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ issueId: string }> },
) {
  const { issueId } = await params;
  const token = _req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const runCtx = validateRunToken(token);
  if (!runCtx) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

  logAgentApiRequest(`/api/issues/${issueId}/documents/plan`, 'GET', runCtx, { issueId });

  const issue = await db.query.issues.findFirst({ where: eq(issues.id, issueId) });
  if (!issue) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (issue.companyId !== runCtx.companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const doc = planPayload(issue);
  if (!doc) {
    logAgentApiResponse(`/api/issues/${issueId}/documents/plan`, 'GET', runCtx, 404, { issueId });
    return NextResponse.json({ error: 'Plan document not found' }, { status: 404 });
  }

  logAgentApiResponse(`/api/issues/${issueId}/documents/plan`, 'GET', runCtx, 200, {
    issueId,
    revisionId: doc.revisionId,
    bodyChars: doc.body.length,
  });
  return NextResponse.json(doc);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ issueId: string }> },
) {
  const { issueId } = await params;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const runCtx = validateRunToken(token);
  if (!runCtx) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

  const raw = await req.json();
  logAgentApiRequest(`/api/issues/${issueId}/documents/plan`, 'PUT', runCtx, {
    issueId,
    body: summarizeBody(raw),
  });

  const parsed = putPlanSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const issue = await db.query.issues.findFirst({ where: eq(issues.id, issueId) });
  if (!issue) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (issue.companyId !== runCtx.companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { body, baseRevisionId } = parsed.data;
  const currentRevision = issue.planDocumentRevisionId;

  // Optimistic concurrency only when a concrete baseRevisionId is supplied.
  // null baseRevisionId = create or last-write-wins overwrite (typical agent path).
  if (baseRevisionId != null && currentRevision != null && baseRevisionId !== currentRevision) {
    return NextResponse.json(
      {
        error: 'revision_conflict',
        message: 'baseRevisionId does not match the current plan revision.',
        revisionId: currentRevision,
      },
      { status: 409 },
    );
  }

  const revisionId = randomUUID();
  const updatedAt = new Date();
  const [updated] = await db
    .update(issues)
    .set({
      planDocumentBody: body,
      planDocumentRevisionId: revisionId,
      planDocumentUpdatedAt: updatedAt,
      updatedAt,
    })
    .where(eq(issues.id, issueId))
    .returning();

  const doc = planPayload(updated)!;
  logAgentApiResponse(`/api/issues/${issueId}/documents/plan`, 'PUT', runCtx, 200, {
    issueId,
    revisionId: doc.revisionId,
    bodyChars: doc.body.length,
  });
  return NextResponse.json(doc);
}
