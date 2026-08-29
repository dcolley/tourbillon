import { NextResponse } from 'next/server';
import { listCompanies, setActiveCompanyCookie } from '@/lib/company';
import { SignJWT } from 'jose';

const SESSION_SECRET = new TextEncoder().encode(
  process.env.BETTER_AUTH_SECRET || 'change-me-in-production'
);

/**
 * GET /api/mobile/companies
 * List all companies (for mobile company selection)
 */
export async function GET() {
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
 * Select active company and return a session token
 * Body: { companyId: string }
 */
export async function POST(req: Request) {
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
    const { getCompanyById } = await import('@/lib/company');
    const company = await getCompanyById(companyId);
    if (!company) {
      return NextResponse.json(
        { error: 'Company not found' },
        { status: 404 }
      );
    }
    
    // Set cookie for web compatibility
    await setActiveCompanyCookie(companyId);
    
    // Issue a JWT session token for mobile
    const token = await new SignJWT({ companyId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(SESSION_SECRET);
    
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
