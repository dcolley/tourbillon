import { NextRequest, NextResponse } from 'next/server';
import { validateRunToken } from '@/lib/auth/run-token';
import { logAgentApiRequest, logAgentApiResponse } from '@/lib/agent-api-trace';
import {
  getProjectDetailForAgent,
  updateProject,
  ProjectValidationError,
} from '@/lib/projects';

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string; projectId: string }> },
) {
  const { companyId, projectId } = await params;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return unauthorized();
  const runCtx = validateRunToken(token);
  if (!runCtx) return unauthorized();
  if (runCtx.companyId !== companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  logAgentApiRequest(
    `/api/companies/${companyId}/projects/${projectId}`,
    'GET',
    runCtx,
    { projectId },
  );

  const detail = await getProjectDetailForAgent(projectId, companyId);
  if (!detail) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  logAgentApiResponse(
    `/api/companies/${companyId}/projects/${projectId}`,
    'GET',
    runCtx,
    200,
    { issueCount: detail.issues.length },
  );

  return NextResponse.json(detail);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string; projectId: string }> },
) {
  const { companyId, projectId } = await params;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return unauthorized();
  const runCtx = validateRunToken(token);
  if (!runCtx) return unauthorized();
  if (runCtx.companyId !== companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = (await req.json()) as {
    title?: string;
    description?: string | null;
    status?: string;
    goalId?: string;
    ownerAgentId?: string | null;
  };

  logAgentApiRequest(
    `/api/companies/${companyId}/projects/${projectId}`,
    'PATCH',
    runCtx,
    { projectId },
  );

  try {
    const project = await updateProject(projectId, body);
    if (project.companyId !== companyId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    logAgentApiResponse(
      `/api/companies/${companyId}/projects/${projectId}`,
      'PATCH',
      runCtx,
      200,
      { projectId: project.id },
    );
    return NextResponse.json(project);
  } catch (err) {
    if (err instanceof ProjectValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
