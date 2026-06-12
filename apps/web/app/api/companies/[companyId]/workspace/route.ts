import { NextRequest, NextResponse } from 'next/server';
import { validateRunToken } from '@/lib/auth/run-token';
import { logAgentApiRequest, logAgentApiResponse } from '@/lib/agent-api-trace';
import {
  listWorkspaceEntries,
  WorkspacePathError,
} from '@/lib/company-workspace';

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> }
) {
  const { companyId } = await params;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return unauthorized();
  const runCtx = validateRunToken(token);
  if (!runCtx) return unauthorized();
  if (runCtx.companyId !== companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const pathParam = req.nextUrl.searchParams.get('path') ?? '';
  const recursive = req.nextUrl.searchParams.get('recursive') === 'true';

  logAgentApiRequest(`/api/companies/${companyId}/workspace`, 'GET', runCtx, {
    path: pathParam,
    recursive,
  });

  try {
    const entries = await listWorkspaceEntries(companyId, {
      relativeDir: pathParam,
      recursive,
    });
    logAgentApiResponse(`/api/companies/${companyId}/workspace`, 'GET', runCtx, 200, {
      entryCount: entries.length,
    });
    return NextResponse.json({ entries });
  } catch (err) {
    if (err instanceof WorkspacePathError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
