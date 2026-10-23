import { NextRequest, NextResponse } from 'next/server';
import { db, agents } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { setLlmProviderEnabledForCompany } from '@/lib/llm-providers';
import { requireBoardCompany } from '@/lib/board-route-auth';
import { invalidateChatControllerForAgent } from '@/lib/chat';

/** Cached chat controllers hold their provider; drop this company's so the next chat re-resolves. */
async function invalidateCompanyChats(companyId: string): Promise<void> {
  try {
    const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, companyId));
    for (const row of rows) invalidateChatControllerForAgent(row.id);
  } catch (err) {
    console.warn('[llm-providers] chat cache not cleared after provider toggle', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * PRV-1: switch one provider on or off for one company. Body `{ enabled: boolean }`.
 *
 * Board (company admin) only: agent run/chat tokens → 403, no board session → 401, and the
 * path company must be the board's active company (other company → 403).
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string; id: string }> },
) {
  const auth = await requireBoardCompany(req);
  if (!auth.ok) return auth.response;
  const { companyId, id } = await params;
  if (auth.value.id !== companyId) {
    return NextResponse.json({ error: 'Forbidden: not the active company' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON: { "enabled": true | false }' }, { status: 400 });
  }
  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== 'boolean') {
    return NextResponse.json({ error: '"enabled" must be true or false' }, { status: 400 });
  }

  try {
    const result = await setLlmProviderEnabledForCompany(companyId, id, enabled);
    if (!result) return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
    if (result.changed) await invalidateCompanyChats(companyId);
    return NextResponse.json({
      providerId: result.providerId,
      companyId: result.companyId,
      enabledForCompany: result.enabledForCompany,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update provider';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
