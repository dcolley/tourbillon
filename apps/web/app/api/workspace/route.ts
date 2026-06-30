import { NextRequest, NextResponse } from 'next/server';
import { getActiveCompany } from '@/lib/company';
import { listWorkspaceEntries, WorkspacePathError } from '@/lib/company-workspace';

export async function GET(req: NextRequest) {
  const company = await getActiveCompany();
  const pathParam = req.nextUrl.searchParams.get('path') ?? '';
  const recursive = req.nextUrl.searchParams.get('recursive') === 'true';

  try {
    const entries = await listWorkspaceEntries(company.id, {
      relativeDir: pathParam,
      recursive,
    });
    return NextResponse.json({ entries });
  } catch (err) {
    if (err instanceof WorkspacePathError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
