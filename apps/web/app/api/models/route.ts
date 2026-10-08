import { NextRequest, NextResponse } from 'next/server';
import { db, agents } from '@tourbillon/db';
import { and, eq } from 'drizzle-orm';
import { getLlmProviderRecordById } from '@/lib/llm-providers';
import {
  listProviderModelsForAgent,
  listProviderModelsForRecord,
} from '@/lib/model-catalog';
import { defaultProviderModelsResponse } from '@/lib/default-provider-models';
import { requireBoardCompany, requireBoardIdentity } from '@/lib/board-route-auth';

export async function GET(req: NextRequest) {
  const agentId = req.nextUrl.searchParams.get('agentId');
  const providerId = req.nextUrl.searchParams.get('providerId');

  // #106: board only. Agent-scoped lookups are limited to the board's company (other → 404).
  const auth = agentId && !providerId ? await requireBoardCompany(req) : await requireBoardIdentity(req);
  if (!auth.ok) return auth.response;

  try {
    if (providerId) {
      const record = await getLlmProviderRecordById(providerId);
      if (!record) {
        return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
      }
      const result = await listProviderModelsForRecord(record);
      return NextResponse.json(result);
    }

    if (agentId) {
      const companyId = auth.value === true ? null : auth.value.id;
      if (!companyId) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
      const agent = await db.query.agents.findFirst({
        where: and(eq(agents.id, agentId), eq(agents.companyId, companyId)),
      });
      if (!agent) {
        return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
      }

      const providerRecord = agent.providerId
        ? await getLlmProviderRecordById(agent.providerId)
        : null;

      const result = await listProviderModelsForAgent(
        agent.adapterType,
        agent.adapterConfig,
        agent.modelId,
        providerRecord,
      );
      return NextResponse.json(result);
    }

    // Registry default provider first, env only when there is no default; clear 409/502/503 JSON
    // errors instead of a bare 502 (see lib/default-provider-models.ts).
    return await defaultProviderModelsResponse();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list models';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
