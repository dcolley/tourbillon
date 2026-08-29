import { NextResponse } from 'next/server';
import { listCompanies } from '@/lib/company';

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
