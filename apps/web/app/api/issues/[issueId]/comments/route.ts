import { NextRequest, NextResponse } from 'next/server';
import { db, issues, agents } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { validateRunToken } from '@/lib/auth/run-token';
import { logAgentApiRequest, logAgentApiResponse, summarizeBody } from '@/lib/agent-api-trace';
import { addIssueComment, listIssueComments } from '@/lib/issue-comments';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ issueId: string }> }
) {
  const { issueId } = await params;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const runCtx = validateRunToken(token);
  if (!runCtx) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

  const after = req.nextUrl.searchParams.get('after') ?? undefined;
  const order = (req.nextUrl.searchParams.get('order') ?? 'asc') as 'asc' | 'desc';

  logAgentApiRequest(`/api/issues/${issueId}/comments`, 'GET', runCtx, {
    issueId: issueId,
    after,
    order,
  });

  const issue = await db.query.issues.findFirst({ where: eq(issues.id, issueId) });
  if (!issue) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (issue.companyId !== runCtx.companyId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { comments, latestId } = await listIssueComments(issueId, runCtx.companyId, {
    after,
    order,
  });

  logAgentApiResponse(`/api/issues/${issueId}/comments`, 'GET', runCtx, 200, {
    issueId: issueId,
    count: comments.length,
    latestId,
  });

  return NextResponse.json({ comments, latestId, total: comments.length });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ issueId: string }> }
) {
  const { issueId } = await params;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const runCtx = validateRunToken(token);
  if (!runCtx) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

  const runId = req.headers.get('x-paperclip-run-id') ?? runCtx.runId;
  const body = (await req.json()) as { body?: string };

  logAgentApiRequest(`/api/issues/${issueId}/comments`, 'POST', runCtx, {
    issueId: issueId,
    body: summarizeBody(body),
  });

  const issue = await db.query.issues.findFirst({ where: eq(issues.id, issueId) });
  if (!issue) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (issue.companyId !== runCtx.companyId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (!body.body?.trim()) {
    return NextResponse.json({ error: 'body is required' }, { status: 400 });
  }

  const agent = await db.query.agents.findFirst({ where: eq(agents.id, runCtx.agentId) });

  try {
    const comment = await addIssueComment(
      issueId,
      runCtx.companyId,
      { type: 'agent', id: runCtx.agentId, name: agent?.name },
      body.body,
      runId
    );

    logAgentApiResponse(`/api/issues/${issueId}/comments`, 'POST', runCtx, 201, {
      issueId: issueId,
      commentId: comment.id,
    });

    return NextResponse.json(comment, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
