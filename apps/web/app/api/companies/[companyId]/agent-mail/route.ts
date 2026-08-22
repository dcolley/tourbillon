import { NextRequest, NextResponse } from 'next/server';
import { db, agentMail, agents } from '@tourbillon/db';
import { eq, or, and, desc, inArray } from 'drizzle-orm';
import { validateRunToken } from '@/lib/auth/run-token';
import { enqueueHeartbeat } from '@/lib/wake-client';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> }
) {
  const { companyId } = await params;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const runCtx = validateRunToken(token);
  if (!runCtx) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }
  if (runCtx.companyId !== companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = (await req.json()) as {
    toAgentId?: string;
    toAgentUrlKey?: string;
    body: string;
    inReplyTo?: string;
  };

  if (!body.body?.trim()) {
    return NextResponse.json({ error: 'Message body required' }, { status: 400 });
  }

  if (!body.toAgentId && !body.toAgentUrlKey) {
    return NextResponse.json({ error: 'toAgentId or toAgentUrlKey required' }, { status: 400 });
  }

  if (body.toAgentId && body.toAgentUrlKey) {
    return NextResponse.json({ error: 'Provide toAgentId OR toAgentUrlKey, not both' }, { status: 400 });
  }

  // Resolve recipient
  let toAgent;
  if (body.toAgentId) {
    toAgent = await db.query.agents.findFirst({
      where: and(eq(agents.id, body.toAgentId), eq(agents.companyId, companyId)),
    });
  } else if (body.toAgentUrlKey) {
    toAgent = await db.query.agents.findFirst({
      where: and(eq(agents.urlKey, body.toAgentUrlKey), eq(agents.companyId, companyId)),
    });
  }

  if (!toAgent) {
    return NextResponse.json({ error: 'Recipient agent not found' }, { status: 404 });
  }

  // No self-send
  if (toAgent.id === runCtx.agentId) {
    return NextResponse.json({ error: 'Cannot send mail to yourself' }, { status: 400 });
  }

  // Verify inReplyTo if provided
  if (body.inReplyTo) {
    const parentMail = await db.query.agentMail.findFirst({
      where: and(eq(agentMail.id, body.inReplyTo), eq(agentMail.companyId, companyId)),
    });
    if (!parentMail) {
      return NextResponse.json({ error: 'inReplyTo mail not found' }, { status: 404 });
    }
  }

  // Insert mail
  const [mail] = await db
    .insert(agentMail)
    .values({
      companyId,
      fromAgentId: runCtx.agentId,
      toAgentId: toAgent.id,
      body: body.body.trim(),
      inReplyTo: body.inReplyTo,
    })
    .returning();

  // Get sender name for wake message
  const fromAgent = await db.query.agents.findFirst({
    where: eq(agents.id, runCtx.agentId),
  });

  // Wake recipient
  await enqueueHeartbeat({
    agentId: toAgent.id,
    companyId,
    invocationSource: 'agent_mail',
    wakeReason: 'agent_mail',
    mailId: mail.id,
    mailFromAgentId: runCtx.agentId,
    mailFromAgentName: fromAgent?.name,
    mailBody: mail.body,
  });

  return NextResponse.json({ id: mail.id, toAgentId: toAgent.id, createdAt: mail.createdAt }, { status: 201 });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> }
) {
  const { companyId } = await params;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const runCtx = validateRunToken(token);
  if (!runCtx) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }
  if (runCtx.companyId !== companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const agentId = searchParams.get('agentId');
  const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100);

  const targetAgentId = agentId || runCtx.agentId;

  // Get sent and received mail
  const mails = await db
    .select()
    .from(agentMail)
    .where(
      and(
        eq(agentMail.companyId, companyId),
        or(eq(agentMail.fromAgentId, targetAgentId), eq(agentMail.toAgentId, targetAgentId))
      )
    )
    .orderBy(desc(agentMail.createdAt))
    .limit(limit);

  // Fetch agent info for all referenced agents
  const agentIds = new Set<string>();
  for (const mail of mails) {
    agentIds.add(mail.fromAgentId);
    agentIds.add(mail.toAgentId);
  }
  
  const agentList = await db
    .select({ id: agents.id, name: agents.name, urlKey: agents.urlKey })
    .from(agents)
    .where(inArray(agents.id, Array.from(agentIds)));
  
  const agentMap = new Map(agentList.map(a => [a.id, a]));

  const mailsWithAgents = mails.map(mail => ({
    ...mail,
    fromAgent: agentMap.get(mail.fromAgentId),
    toAgent: agentMap.get(mail.toAgentId),
  }));

  return NextResponse.json({ mails: mailsWithAgents }, { status: 200 });
}
