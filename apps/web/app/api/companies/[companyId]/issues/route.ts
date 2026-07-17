import { NextRequest, NextResponse } from 'next/server';
import { db, issues, companies, agents } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { IssueAssigneeError, resolveIssueAssignees } from '@tourbillon/shared';
import { validateRunToken } from '@/lib/auth/run-token';
import { validateSchedulerKey } from '@/lib/auth/scheduler-key';
import { logIssueCreated } from '@/lib/issues';
import { enqueueHeartbeat } from '@/lib/wake-client';

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

  const body = (await req.json()) as {
    title: string;
    description?: string;
    parentId?: string;
    goalId?: string;
    assigneeAgentId?: string;
    assigneeUserId?: string;
    priority?: string;
    blockedByIssueIds?: string[];
    billingCode?: string;
    routineId?: string;
    source?: string;
  };

  let assignees;
  try {
    assignees = resolveIssueAssignees({
      assigneeAgentId: body.assigneeAgentId,
      assigneeUserId: body.assigneeUserId,
    });
  } catch (err) {
    if (err instanceof IssueAssigneeError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  // Generate identifier: ACME-42
  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 });

  if (assignees.assigneeAgentId) {
    const agent = await db.query.agents.findFirst({
      where: eq(agents.id, assignees.assigneeAgentId),
    });
    if (!agent || agent.companyId !== companyId) {
      return NextResponse.json({ error: 'Assignee agent not found' }, { status: 400 });
    }
  }

  const [updatedCompany] = await db
    .update(companies)
    .set({ issueCounter: company.issueCounter + 1 })
    .where(eq(companies.id, companyId))
    .returning();

  const identifier = `${company.issuePrefix}-${updatedCompany.issueCounter}`;
  const hasAssignee = Boolean(assignees.assigneeAgentId || assignees.assigneeUserId);
  const status = hasAssignee ? 'todo' : 'backlog';

  const [newIssue] = await db
    .insert(issues)
    .values({
      companyId: companyId,
      identifier,
      title: body.title,
      description: body.description,
      status,
      priority: (body.priority as 'critical' | 'high' | 'medium' | 'low') ?? 'medium',
      parentId: body.parentId,
      goalId: body.goalId,
      assigneeAgentId: assignees.assigneeAgentId,
      assigneeUserId: assignees.assigneeUserId,
      blockedByIssueIds: body.blockedByIssueIds ?? [],
      billingCode: body.billingCode ?? 'default',
      routineId: body.routineId,
      source: (body.source as 'agent' | 'routine' | 'manual') ?? 'agent',
    })
    .returning();

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

  if (assignees.assigneeAgentId) {
    await enqueueHeartbeat({
      agentId: assignees.assigneeAgentId,
      companyId: companyId,
      invocationSource: 'assignment',
      wakeReason: 'assignment',
      taskId: newIssue.id,
    });
  }

  return NextResponse.json(newIssue, { status: 201 });
}
