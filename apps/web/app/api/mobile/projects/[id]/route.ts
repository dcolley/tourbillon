import { NextRequest, NextResponse } from 'next/server';
import { getProjectDetail } from '@/lib/projects';
import { requireMobileCompany, toJson } from '@/lib/mobile-session';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireMobileCompany(req);
  if ('error' in auth) return auth.error;

  try {
    const { id } = await params;
    const detail = await getProjectDetail(id);
    if (!detail || detail.project.companyId !== auth.company.id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json(toJson(detail));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load project';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
