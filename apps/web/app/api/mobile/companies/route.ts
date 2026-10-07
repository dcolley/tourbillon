import { NextRequest, NextResponse } from 'next/server';
import { getCompanyById, hasBoardSession, listCompanies, setActiveCompanyCookie } from '@/lib/company';
import { verifyMobileToken } from '@/lib/mobile-auth';
import {
  BOARD_SECRET_HEADER,
  hasAgentToken,
  isBoardAuthConfigured,
  mintBoardJwt,
  verifyOperatorSecret,
} from '@/lib/board-auth';

/** #105: 401 with an empty body (no hint about which credential was missing). */
function unauthorized() {
  return new NextResponse(null, { status: 401 });
}

/** Operator secret presented in X-Board-Secret, and the request is not an agent. */
function hasOperatorSecret(req: NextRequest): boolean {
  if (hasAgentToken(req.headers.get('authorization'))) return false;
  const presented = req.headers.get(BOARD_SECRET_HEADER);
  if (!presented) return false; // always required, even with the local-dev opt-in
  return verifyOperatorSecret(presented);
}

/**
 * GET /api/mobile/companies
 * List companies. #105: board only: a valid board JWT (X-Company-Token), a board session
 * cookie, or the operator secret (X-Board-Secret, used by pairing before a token exists).
 */
export async function GET(req: NextRequest) {
  const isBoard =
    (await verifyMobileToken(req)) !== null ||
    hasOperatorSecret(req) ||
    (await hasBoardSession());
  if (!isBoard) return unauthorized();

  try {
    const companies = await listCompanies();

    return NextResponse.json(
      companies.map((c) => ({
        id: c.id,
        name: c.name,
        issuePrefix: c.issuePrefix,
        slug: c.slug,
      }))
    );
  } catch (error) {
    console.error('Mobile API: Failed to list companies:', error);
    return NextResponse.json(
      { error: 'Failed to load companies' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/mobile/companies
 * Select active company and return a board JWT.
 * Body: { companyId: string }
 * #105: requires the operator secret in X-Board-Secret (TOURBILLON_BOARD_SECRET).
 * Fails closed (401) when TOURBILLON_BOARD_SECRET is unset, unless local-dev opt-in
 * TOURBILLON_BOARD_AUTH_INSECURE_DEV=1 is set outside production.
 */
export async function POST(req: NextRequest) {
  if (!isBoardAuthConfigured()) {
    console.warn('Mobile API: TOURBILLON_BOARD_SECRET is not set; refusing to mint board tokens');
    return unauthorized();
  }
  if (!hasOperatorSecret(req)) return unauthorized();

  try {
    const body = await req.json();
    const { companyId } = body as { companyId?: string };
    
    if (!companyId) {
      return NextResponse.json(
        { error: 'companyId is required' },
        { status: 400 }
      );
    }
    
    // Verify company exists
    const company = await getCompanyById(companyId);
    if (!company) {
      return NextResponse.json(
        { error: 'Company not found' },
        { status: 404 }
      );
    }
    
    // Issue a board JWT (fails closed if no usable signing key, e.g. default secret in production)
    const token = await mintBoardJwt(companyId);
    if (!token) {
      console.error('Mobile API: BETTER_AUTH_SECRET unset or default in production; cannot mint');
      return NextResponse.json({ error: 'Board auth is not configured' }, { status: 503 });
    }

    // Company selection cookie for web (selects only; does not grant board, see #105)
    await setActiveCompanyCookie(companyId);
    
    return NextResponse.json({
      success: true,
      token,
      company: {
        id: company.id,
        name: company.name,
        issuePrefix: company.issuePrefix,
        slug: company.slug,
      },
    });
  } catch (error) {
    console.error('Mobile API: Failed to select company:', error);
    return NextResponse.json(
      { error: 'Failed to select company' },
      { status: 500 }
    );
  }
}
