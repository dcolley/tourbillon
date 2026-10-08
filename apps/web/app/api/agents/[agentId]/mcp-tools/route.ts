import { NextRequest, NextResponse } from 'next/server';
import { db, agents, companies } from '@tourbillon/db';
import { and, eq } from 'drizzle-orm';
import { listMcpToolsForAgent } from '@tourbillon/mastra/mcp-tools';
import { parseCompanySettings } from '@tourbillon/shared';
import { requireBoardCompany } from '@/lib/board-route-auth';

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await context.params;

  // #106: board only; agent lookup scoped to the board's company (other company → 404).
  const auth = await requireBoardCompany(req);
  if (!auth.ok) return auth.response;

  const agent = await db.query.agents.findFirst({
    where: and(eq(agents.id, agentId), eq(agents.companyId, auth.value.id)),
  });
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }

  const company = await db.query.companies.findFirst({
    where: eq(companies.id, agent.companyId),
  });
  if (!company) {
    return NextResponse.json({ error: 'Company not found' }, { status: 404 });
  }

  const toolsetsParam = req.nextUrl.searchParams.get('toolsets');
  const assignedToolsets =
    toolsetsParam !== null
      ? toolsetsParam
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

  const mcpServersParam = req.nextUrl.searchParams.get('mcpServers');
  const mcpServerIds =
    mcpServersParam !== null
      ? mcpServersParam
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

  const kgPrivateParam = req.nextUrl.searchParams.get('kgPrivate');
  const kgCompanyParam = req.nextUrl.searchParams.get('kgCompany');
  const knowledgeGraph =
    kgPrivateParam !== null || kgCompanyParam !== null
      ? {
          private: kgPrivateParam !== '0',
          company: kgCompanyParam === '1',
        }
      : undefined;

  try {
    const servers = await listMcpToolsForAgent(agent, {
      allowedMcpServerIds: company.allowedMcpServerIds ?? [],
      companySettings: parseCompanySettings(company.settings),
      assignedToolsets,
      mcpServerIds,
      knowledgeGraph,
    });
    return NextResponse.json({ servers });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list MCP tools';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
