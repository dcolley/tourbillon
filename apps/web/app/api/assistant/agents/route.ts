import { NextRequest, NextResponse } from 'next/server';
import { getActiveCompanyOrNull } from '@/lib/company';
import { verifyMobileToken } from '@/lib/mobile-auth';
import { listAssistantAgents } from '@/lib/assistant/agents';

export const dynamic = 'force-dynamic';

/** UI-2: agents of the active company for the assistant sidebar (status included). */
export async function GET(req: NextRequest) {
  try {
    const mobileCompanyId = await verifyMobileToken(req);
    const company = await getActiveCompanyOrNull(mobileCompanyId);
    if (!company) {
      return NextResponse.json({ error: 'No active company selected' }, { status: 401 });
    }
    const agents = await listAssistantAgents(company.id);
    return NextResponse.json({ companyId: company.id, agents });
  } catch (err) {
    console.error('[assistant-api]', err);
    return NextResponse.json({ error: 'Failed to list agents' }, { status: 500 });
  }
}
