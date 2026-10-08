/**
 * #106: route-level board guards built on the #105 board gate.
 *
 * - `requireBoardCompany(req)`: company-scoped board routes. Agent run/chat token → 403;
 *   otherwise board JWT (X-Company-Token) or board session cookie + active company, else 401.
 *   Callers must scope lookups to `company.id` (other company → 404/403).
 * - `requireBoardIdentity(req)`: instance-global board resources (LLM providers, model catalog).
 *   Agent token → 403; board JWT or board session cookie, else 401.
 *
 * Agents never pass either guard (same rule as #104's agent secrets route).
 */
import { NextResponse, type NextRequest } from 'next/server';
import type { Company } from '@tourbillon/db';
import { getActiveCompanyOrNull, hasBoardSession } from './company';
import { verifyMobileToken } from './mobile-auth';
import { hasAgentToken } from './board-auth';

export type BoardGuard<T> = { ok: true; value: T } | { ok: false; response: NextResponse };

export function agentForbidden(): NextResponse {
  return NextResponse.json({ error: 'Forbidden: board only' }, { status: 403 });
}

export function boardUnauthorized(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function requireBoardCompany(req: NextRequest): Promise<BoardGuard<Company>> {
  if (hasAgentToken(req.headers.get('authorization'))) {
    return { ok: false, response: agentForbidden() };
  }
  const company = await getActiveCompanyOrNull(await verifyMobileToken(req));
  if (!company) return { ok: false, response: boardUnauthorized() };
  return { ok: true, value: company };
}

export async function requireBoardIdentity(req: NextRequest): Promise<BoardGuard<true>> {
  if (hasAgentToken(req.headers.get('authorization'))) {
    return { ok: false, response: agentForbidden() };
  }
  if ((await verifyMobileToken(req)) !== null || (await hasBoardSession())) {
    return { ok: true, value: true };
  }
  return { ok: false, response: boardUnauthorized() };
}
