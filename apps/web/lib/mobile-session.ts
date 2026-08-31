import { NextRequest, NextResponse } from 'next/server';
import type { Company } from '@tourbillon/db';
import { getCompanyById } from './company';
import { verifyMobileToken } from './mobile-auth';

export async function requireMobileCompany(
  req: NextRequest,
): Promise<{ company: Company } | { error: NextResponse }> {
  const companyId = await verifyMobileToken(req);
  if (!companyId) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  const company = await getCompanyById(companyId);
  if (!company) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  return { company };
}

export function toJson<T>(data: T): T {
  return JSON.parse(JSON.stringify(data)) as T;
}
