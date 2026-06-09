import { NextRequest, NextResponse } from 'next/server';
import { db, issues, companies } from '@paperclip-mastra/db';
import { eq } from 'drizzle-orm';
import { validateRunToken } from '@/lib/auth/run-token';
import { enqueueHeartbeat } from '@/lib/queue';

export async function POST(
  req: NextRequest,
  { params }: { params: { companyId: string } }
) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const runCtx = validateRunToken(token);
  if (!runCtx) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  if (runCtx.companyId !== params.companyId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json() as {
    title: string;
    description?: string;
    parentId?: string;
    goalId?: string;
    assigneeAgentId?: string;
    priority?: string;
    blockedByIssueIds?: string[];
    billingCode?: string;
    routineId?: string;
    source?: string;
  };

  // Generate identifier: ACME-42
  const company = await db.query.companies.findFirst({ where: eq(companies.id, params.companyId) });
  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 });

  const [updatedCompany] = await db
    .update(companies)
    .set({ issueCounter: company.issueCounter + 1 })
    .where(eq(companies.id, params.companyId))
    .returning();

  const identifier = `${company.issuePrefix}-${updatedCompany.issueCounter}`;

  const [newIssue] = await db.insert(issues).values({
    companyId: params.companyId,
    identifier,
    title: body.title,
    description: body.description,
    status: 'todo',
    priority: (body.priority as 'critical' | 'high' | 'medium' | 'low') ?? 'medium',
    parentId: body.parentId,
    goalId: body.goalId,
    assigneeAgentId: body.assigneeAgentId,
    blockedByIssueIds: body.blockedByIssueIds ?? [],
    billingCode: body.billingCode ?? 'default',
    routineId: body.routineId,
    source: (body.source as 'agent' | 'routine' | 'manual') ?? 'agent',
  }).returning();

  // Wake the assignee agent
  if (body.assigneeAgentId) {
    await enqueueHeartbeat({
      agentId: body.assigneeAgentId,
      companyId: params.companyId,
      invocationSource: 'assignment',
      wakeReason: 'assignment',
      taskId: newIssue.id,
    });
  }

  return NextResponse.json(newIssue, { status: 201 });
}
