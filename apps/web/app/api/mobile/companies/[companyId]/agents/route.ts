import { NextRequest, NextResponse } from 'next/server';
import { db, agents } from '@tourbillon/db';
import { eq, desc } from 'drizzle-orm';
import { getActiveCompanyOrNull } from '@/lib/company';

/**
 * GET /api/mobile/companies/[companyId]/agents
 * List agents for a company
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> }
) {
  try {
    const { companyId } = await params;
    
    // Verify active company matches requested company
    const activeCompany = await getActiveCompanyOrNull();
    if (!activeCompany || activeCompany.id !== companyId) {
      return NextResponse.json(
        { error: 'Company not selected or mismatch' },
        { status: 403 }
      );
    }
    
    const companyAgents = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        title: agents.title,
        role: agents.role,
        urlKey: agents.urlKey,
        status: agents.status,
        createdAt: agents.createdAt,
        updatedAt: agents.updatedAt,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId))
      .orderBy(desc(agents.createdAt));
    
    return NextResponse.json(
      companyAgents.map((agent) => ({
        ...agent,
        createdAt: agent.createdAt.toISOString(),
        updatedAt: agent.updatedAt.toISOString(),
      }))
    );
  } catch (error) {
    console.error('Mobile API: Failed to list agents:', error);
    return NextResponse.json(
      { error: 'Failed to load agents' },
      { status: 500 }
    );
  }
}
