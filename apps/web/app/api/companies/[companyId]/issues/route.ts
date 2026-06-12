import { NextRequest, NextResponse } from 'next/server';
import { db, issues, companies, agents } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { validateRunToken } from '@/lib/auth/run-token';
import { validateSchedulerKey } from '@/lib/auth/scheduler-key';
import { logIssueCreated } from '@/lib/issues';
import { enqueueHeartbeat } from '@/lib/queue';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> }
) {
  const { companyId } = await params;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const runCtx = validateRunToken(token);
  const isScheduler = validateSchedulerKey(token);

  if (!runCtx && !isScheduler) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }
  if (runCtx && runCtx.companyId !== companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

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
  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 });

  const [updatedCompany] = await db
    .update(companies)
    .set({ issueCounter: company.issueCounter + 1 })
    .where(eq(companies.id, companyId))
    .returning();

  const identifier = `${company.issuePrefix}-${updatedCompany.issueCounter}`;
  const status = body.assigneeAgentId ? 'todo' : 'backlog';

  const [newIssue] = await db.insert(issues).values({
    companyId: companyId,
    identifier,
    title: body.title,
    description: body.description,
    status,
    priority: (body.priority as 'critical' | 'high' | 'medium' | 'low') ?? 'medium',
    parentId: body.parentId,
    goalId: body.goalId,
    assigneeAgentId: body.assigneeAgentId,
    blockedByIssueIds: body.blockedByIssueIds ?? [],
    billingCode: body.billingCode ?? 'default',
    routineId: body.routineId,
    source: (body.source as 'agent' | 'routine' | 'manual') ?? 'agent',
  }).returning();

  if (runCtx) {
    const creator = await db.query.agents.findFirst({ where: eq(agents.id, runCtx.agentId) });
    await logIssueCreated(
      companyId,
      newIssue,
      { type: 'agent', id: runCtx.agentId, name: creator?.name },
      { runId: runCtx.runId, routineId: body.routineId ?? null }
    );
  } else {
    await logIssueCreated(
      companyId,
      newIssue,
      { type: 'system', id: 'scheduler', name: 'Scheduler' },
      { routineId: body.routineId ?? null }
    );
  }

  // Wake the assignee agent
  if (body.assigneeAgentId) {
    await enqueueHeartbeat({
      agentId: body.assigneeAgentId,
      companyId: companyId,
      invocationSource: 'assignment',
      wakeReason: 'assignment',
      taskId: newIssue.id,
    });
  }

  return NextResponse.json(newIssue, { status: 201 });
}
