import { NextRequest, NextResponse } from 'next/server';
import { validateRunToken } from '@/lib/auth/run-token';
import { logAgentApiRequest, logAgentApiResponse } from '@/lib/agent-api-trace';
import {
  createProject,
  listProjectsForAgent,
  ProjectValidationError,
  type ProjectStatus,
} from '@/lib/projects';

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const { companyId } = await params;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return unauthorized();
  const runCtx = validateRunToken(token);
  if (!runCtx) return unauthorized();
  if (runCtx.companyId !== companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const goalId = req.nextUrl.searchParams.get('goalId') ?? undefined;
  const statusParam = req.nextUrl.searchParams.get('status') ?? 'all';
  const statusFilter = (['active', 'paused', 'completed', 'archived', 'all'] as const).includes(
    statusParam as ProjectStatus | 'all',
  )
    ? (statusParam as ProjectStatus | 'all')
    : 'all';

  logAgentApiRequest(`/api/companies/${companyId}/projects`, 'GET', runCtx, {
    goalId,
    status: statusFilter,
  });

  const projectList = await listProjectsForAgent(companyId, { goalId, status: statusFilter });

  logAgentApiResponse(`/api/companies/${companyId}/projects`, 'GET', runCtx, 200, {
    projectCount: projectList.length,
  });

  return NextResponse.json({ projects: projectList });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const { companyId } = await params;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return unauthorized();
  const runCtx = validateRunToken(token);
  if (!runCtx) return unauthorized();
  if (runCtx.companyId !== companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = (await req.json()) as {
    title: string;
    description?: string;
    goalId: string;
    status?: string;
    ownerAgentId?: string;
  };

  logAgentApiRequest(`/api/companies/${companyId}/projects`, 'POST', runCtx, {
    title: body.title,
    goalId: body.goalId,
  });

  try {
    const project = await createProject({
      ...body,
      companyId,
    });
    logAgentApiResponse(`/api/companies/${companyId}/projects`, 'POST', runCtx, 201, {
      projectId: project.id,
    });
    return NextResponse.json(project, { status: 201 });
  } catch (err) {
    if (err instanceof ProjectValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
