import { NextRequest, NextResponse } from 'next/server';
import { validateRunToken } from '@/lib/auth/run-token';
import { logAgentApiRequest, logAgentApiResponse } from '@/lib/agent-api-trace';
import {
  readWorkspaceText,
  writeWorkspaceText,
  deleteWorkspaceEntry,
  WorkspacePathError,
  WorkspaceSizeError,
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

  const filePath = req.nextUrl.searchParams.get('path') ?? '';
  logAgentApiRequest(`/api/companies/${companyId}/workspace/file`, 'GET', runCtx, {
    path: filePath,
  });

  try {
    const file = await readWorkspaceText(companyId, filePath);
    logAgentApiResponse(`/api/companies/${companyId}/workspace/file`, 'GET', runCtx, 200, {
      path: file.path,
      size: file.size,
    });
    return NextResponse.json(file);
  } catch (err) {
    if (err instanceof WorkspacePathError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof WorkspaceSizeError) {
      return NextResponse.json({ error: err.message }, { status: 413 });
    }
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ error: 'File not found.' }, { status: 404 });
    }
    throw err;
  }
}

export async function PUT(
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

  const body = (await req.json()) as { path?: string; content?: string };
  logAgentApiRequest(`/api/companies/${companyId}/workspace/file`, 'PUT', runCtx, {
    path: body.path,
  });

  if (!body.path || typeof body.content !== 'string') {
    return NextResponse.json({ error: 'path and content are required.' }, { status: 400 });
  }

  try {
    const result = await writeWorkspaceText(companyId, body.path, body.content);
    logAgentApiResponse(`/api/companies/${companyId}/workspace/file`, 'PUT', runCtx, 200, result);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof WorkspacePathError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof WorkspaceSizeError) {
      return NextResponse.json({ error: err.message }, { status: 413 });
    }
    throw err;
  }
}

export async function DELETE(
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

  const filePath = req.nextUrl.searchParams.get('path') ?? '';
  logAgentApiRequest(`/api/companies/${companyId}/workspace/file`, 'DELETE', runCtx, {
    path: filePath,
  });

  try {
    const result = await deleteWorkspaceEntry(companyId, filePath);
    logAgentApiResponse(`/api/companies/${companyId}/workspace/file`, 'DELETE', runCtx, 200, result);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof WorkspacePathError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    }
    throw err;
  }
}
