import { NextRequest, NextResponse } from 'next/server';
import { requireMobileCompany, toJson } from '@/lib/mobile-session';
import { listCompanyApprovals } from '../route';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireMobileCompany(req);
  if ('error' in auth) return auth.error;

  try {
    const { id } = await params;
    const list = await listCompanyApprovals(auth.company.id);
    const approval = list.find((row) => row.id === id);
    if (!approval) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ approval: toJson(approval) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load approval';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
