import { NextRequest, NextResponse } from 'next/server';
import { db, agents } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import {
  getLlmProviderRecordById,
  listLlmProvidersPublic,
} from '@/lib/llm-providers';
import {
  listProviderModels,
  listProviderModelsForAgent,
  listProviderModelsForRecord,
} from '@/lib/model-catalog';

export async function GET(req: NextRequest) {
  const agentId = req.nextUrl.searchParams.get('agentId');
  const providerId = req.nextUrl.searchParams.get('providerId');

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
      const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
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

    await listLlmProvidersPublic();
    const result = await listProviderModels();
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list models';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
