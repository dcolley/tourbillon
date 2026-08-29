import { NextRequest, NextResponse } from 'next/server';
import { setActiveCompanyCookie, getCompanyById } from '@/lib/company';

/**
 * POST /api/mobile/companies/[companyId]/select
 * Select active company (sets cookie)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> }
) {
  try {
    const { companyId } = await params;
    
    // Verify company exists
    const company = await getCompanyById(companyId);
    if (!company) {
      return NextResponse.json(
        { error: 'Company not found' },
        { status: 404 }
      );
    }
    
    // Set the active company cookie
    await setActiveCompanyCookie(companyId);
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Mobile API: Failed to select company:', error);
    return NextResponse.json(
      { error: 'Failed to select company' },
      { status: 500 }
    );
  }
}
