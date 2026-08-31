import { NextRequest, NextResponse } from 'next/server';
import { listProjectsForAgent, type ProjectStatus } from '@/lib/projects';
import { requireMobileCompany, toJson } from '@/lib/mobile-session';

export async function GET(req: NextRequest) {
  const auth = await requireMobileCompany(req);
  if ('error' in auth) return auth.error;

  try {
    const statusParam = req.nextUrl.searchParams.get('status') ?? 'all';
    const status = (
      ['active', 'paused', 'completed', 'archived', 'all'] as const
    ).includes(statusParam as ProjectStatus | 'all')
      ? (statusParam as ProjectStatus | 'all')
      : 'all';
    const projects = await listProjectsForAgent(auth.company.id, { status });
    return NextResponse.json({ projects: toJson(projects) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list projects';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
