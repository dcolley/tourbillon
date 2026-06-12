import { NextRequest, NextResponse } from 'next/server';
import { db, agents } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { listProviderModels, listProviderModelsForAgent } from '@/lib/model-catalog';

export async function GET(req: NextRequest) {
  const agentId = req.nextUrl.searchParams.get('agentId');

  try {
    if (agentId) {
      const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
      if (!agent) {
        return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
      }

      const result = await listProviderModelsForAgent(
        agent.adapterType,
        agent.adapterConfig,
        agent.modelId,
      );
      return NextResponse.json(result);
    }

    const result = await listProviderModels();
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list models';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
