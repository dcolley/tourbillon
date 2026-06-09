import { NextRequest, NextResponse } from 'next/server';
import { db, approvals, agents } from '@paperclip-mastra/db';
import { eq } from 'drizzle-orm';
import { validateRunToken } from '@/lib/auth/run-token';

export async function POST(
  req: NextRequest,
  { params }: { params: { companyId: string } }
) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const runCtx = validateRunToken(token);
  if (!runCtx) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  if (runCtx.companyId !== params.companyId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json() as {
    type: string;
    issueIds?: string[];
    payload: object;
    requestedByAgentId?: string;
  };

  const [approval] = await db.insert(approvals).values({
    companyId: params.companyId,
    type: body.type,
    status: 'pending',
    requestedByAgentId: body.requestedByAgentId ?? runCtx.agentId,
    issueIds: body.issueIds ?? [],
    payload: body.payload,
  }).returning();

  return NextResponse.json(approval, { status: 201 });
}
