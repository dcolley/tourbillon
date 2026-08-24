import { NextRequest, NextResponse } from 'next/server';
import { db, agentMail, agents } from '@tourbillon/db';
import { eq, or, and, desc, inArray } from 'drizzle-orm';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> }
) {
  const { companyId } = await params;
  const { searchParams } = new URL(req.url);
  const agentId = searchParams.get('agentId');
  const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100);

  if (!agentId) {
    return NextResponse.json({ error: 'agentId query parameter required' }, { status: 400 });
  }

  // Get sent and received mail
  const mails = await db
    .select()
    .from(agentMail)
    .where(
      and(
        eq(agentMail.companyId, companyId),
        or(eq(agentMail.fromAgentId, agentId), eq(agentMail.toAgentId, agentId))
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
    createdAt: mail.createdAt.toISOString(),
    fromAgent: agentMap.get(mail.fromAgentId),
    toAgent: agentMap.get(mail.toAgentId),
  }));

  return NextResponse.json({ mails: mailsWithAgents }, { status: 200 });
}
