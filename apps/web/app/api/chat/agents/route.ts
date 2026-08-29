import { NextRequest, NextResponse } from 'next/server';
import { db, agents, llmProviders } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { getActiveCompanyOrNull } from '@/lib/company';
import { verifyMobileToken } from '@/lib/mobile-auth';

/** List company agents available for chat agent-switching. */
export async function GET(req: NextRequest) {
  try {
    // Support mobile token-based auth
    const mobileCompanyId = await verifyMobileToken(req);
    const company = await getActiveCompanyOrNull(mobileCompanyId);
    
    if (!company) {
      return NextResponse.json(
        { error: 'No active company selected' },
        { status: 401 }
      );
    }
    
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        urlKey: agents.urlKey,
        modelId: agents.modelId,
        adapterType: agents.adapterType,
        providerName: llmProviders.name,
        providerType: llmProviders.type,
      })
      .from(agents)
      .leftJoin(llmProviders, eq(agents.providerId, llmProviders.id))
      .where(eq(agents.companyId, company.id))
      .orderBy(agents.name);

    return NextResponse.json({
      agents: rows.map((a) => ({
        id: a.id,
        name: a.name,
        urlKey: a.urlKey,
        modelId: a.modelId ?? null,
        providerName: a.providerName ?? a.adapterType ?? null,
        providerType: a.providerType ?? null,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list agents';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
