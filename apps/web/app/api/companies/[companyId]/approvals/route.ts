import { NextRequest, NextResponse } from 'next/server';
import { db, approvals, issues, activityLog, companies, agents, type IssueStatus } from '@tourbillon/db';
import { and, eq, inArray, desc, gte, or, ilike, sql } from 'drizzle-orm';
import { authenticateAgentToken } from '@/lib/auth/agent-token-auth';
import { parseCompanySettings, resolveHitlyGate, publicOriginFromRequest } from '@tourbillon/shared';
import { ingestHitlyApproval, type HitlyIngestPayload } from '@/lib/hitly/client';
import { randomBytes } from 'crypto';
import { approvalCreatedActivity } from '@/lib/approval-activity';

type ApprovalPayload = Record<string, unknown> & {
  title?: string;
  summary?: string;
  priorStatuses?: Record<string, IssueStatus>;
};

function generateResumeToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> }
) {
  const { companyId } = await params;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const runCtx = await authenticateAgentToken(token);
  if (!runCtx) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  if (runCtx.companyId !== companyId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = (await req.json()) as {
    type: string;
    issueIds?: string[];
    payload: ApprovalPayload;
    requestedByAgentId?: string;
  };

  const issueIds = [...new Set((body.issueIds ?? []).filter(Boolean))];
  const basePayload: ApprovalPayload =
    body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
      ? { ...body.payload }
      : {};

  try {
    // Load company settings to check HITLy gate
    const company = await db.query.companies.findFirst({
      where: eq(companies.id, companyId),
    });
    
    if (!company) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 });
    }

    const settings = parseCompanySettings(company.settings);
    const hitlyGate = resolveHitlyGate(settings);
    
    // Check if this approval type should be forwarded to HITLy
    const shouldForwardToHitly =
      hitlyGate &&
      hitlyGate.enabled &&
      (!hitlyGate.types || hitlyGate.types.length === 0 || hitlyGate.types.includes(body.type));

    const approval = await db.transaction(async (tx) => {
      const priorStatuses: Record<string, IssueStatus> = {};

      if (issueIds.length > 0) {
        const linked = await tx
          .select({
            id: issues.id,
            status: issues.status,
            boardApprovalId: issues.boardApprovalId,
            identifier: issues.identifier,
          })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));

        if (linked.length !== issueIds.length) {
          throw Object.assign(new Error('One or more issueIds were not found in this company'), {
            status: 400,
          });
        }

        const alreadyHalted = linked.find((row) => row.boardApprovalId);
        if (alreadyHalted) {
          throw Object.assign(
            new Error(
              `Issue ${alreadyHalted.identifier} is already halted for board approval ${alreadyHalted.boardApprovalId}`,
            ),
            { status: 409 },
          );
        }

        for (const row of linked) {
          priorStatuses[row.id] = row.status;
        }
      }

      const payload: ApprovalPayload = {
        ...basePayload,
        ...(Object.keys(priorStatuses).length > 0 ? { priorStatuses } : {}),
      };

      const [created] = await tx
        .insert(approvals)
        .values({
          companyId,
          type: body.type,
          status: 'pending',
          requestedByAgentId: body.requestedByAgentId ?? runCtx.agentId,
          issueIds,
          payload,
        })
        .returning();

      // approval.created (PM #130): actor is the calling agent (token), note is the summary.
      const [actorAgent] = await tx
        .select({ name: agents.name })
        .from(agents)
        .where(and(eq(agents.id, runCtx.agentId), eq(agents.companyId, companyId)))
        .limit(1);
      await tx.insert(activityLog).values(
        approvalCreatedActivity({
          approval: created,
          actor: { type: 'agent', id: runCtx.agentId, name: actorAgent?.name ?? null },
        }),
      );

      if (issueIds.length > 0) {
        const now = new Date();
        await tx
          .update(issues)
          .set({
            status: 'blocked',
            boardApprovalId: created.id,
            checkoutRunId: null,
            executionLockedAt: null,
            executionAgentNameKey: null,
            updatedAt: now,
          })
          .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));

        for (const issueId of issueIds) {
          await tx.insert(activityLog).values({
            companyId,
            actorType: 'agent',
            actorId: runCtx.agentId,
            action: 'issue.updated',
            entityType: 'issue',
            entityId: issueId,
            details: {
              status: 'blocked',
              boardApprovalId: created.id,
              priorStatus: priorStatuses[issueId],
              comment: `Blocked pending board approval (${created.type}).`,
              runId: runCtx.runId,
            },
          });
        }
      }

      return created;
    });

    // Forward to HITLy if gate is enabled
    if (shouldForwardToHitly && hitlyGate) {
      try {
        const resumeToken = generateResumeToken();
        const resumeUrl = new URL(
          `/api/approvals/${approval.id}/hitly-resume`,
          hitlyGate.resumeHost,
        );
        resumeUrl.searchParams.set('token', resumeToken);
        const resumeUrlString = resumeUrl.toString();

        const approvalUrl = new URL(`/approval`, publicOriginFromRequest(req)).toString();
        
        const title = typeof basePayload.title === 'string' ? basePayload.title : approval.type;
        const summary = typeof basePayload.summary === 'string' ? basePayload.summary : '';
        
        const contextMarkdown = [
          `# ${title}`,
          summary,
          issueIds.length > 0 ? `\n**Linked Issues:** ${issueIds.length}` : '',
        ]
          .filter(Boolean)
          .join('\n\n');

        const hitlyPayload: HitlyIngestPayload = {
          plugin: 'http',
          projectId: hitlyGate.projectId!,
          runId: approval.id,
          actionName: approval.type,
          contextMarkdown,
          metadata: {
            companyId: approval.companyId,
            approvalId: approval.id,
            issueIds: approval.issueIds,
          },
          resumeUrl: resumeUrlString,
          args: basePayload,
          externalUrls: [
            {
              url: approvalUrl,
              label: 'View in Tourbillon',
            },
          ],
        };

        const hitlyApprovalId = await ingestHitlyApproval(hitlyGate, hitlyPayload, approval.id);

        // Store HITLy approval id and resume token
        const currentPayload = approval.payload as Record<string, unknown>;
        await db
          .update(approvals)
          .set({
            hitlyApprovalId,
            payload: { ...currentPayload, hitlyResumeToken: resumeToken },
            updatedAt: new Date(),
          })
          .where(eq(approvals.id, approval.id));

        approval.hitlyApprovalId = hitlyApprovalId;
      } catch (hitlyErr: unknown) {
        // Fail-closed: store error but keep approval pending
        const errorMsg =
          hitlyErr instanceof Error ? hitlyErr.message : 'Unknown HITLy ingest error';
        console.error('[createApproval] HITLy ingest failed:', errorMsg);

        await db
          .update(approvals)
          .set({
            hitlyError: errorMsg,
            updatedAt: new Date(),
          })
          .where(eq(approvals.id, approval.id));

        approval.hitlyError = errorMsg;
      }
    }

    return NextResponse.json(approval, { status: 201 });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw err;
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> }
) {
  const { companyId } = await params;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const runCtx = await authenticateAgentToken(token);
  if (!runCtx) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  if (runCtx.companyId !== companyId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const url = new URL(req.url);
    
    // Parse query parameters
    const statusParam = url.searchParams.get('status') || 'all';
    const typeParam = url.searchParams.get('type');
    const qParam = url.searchParams.get('q');
    const createdAfterParam = url.searchParams.get('createdAfter');
    const decidedAfterParam = url.searchParams.get('decidedAfter');
    const limitParam = parseInt(url.searchParams.get('limit') || '20', 10);
    
    // Validate and clamp limit
    const limit = Math.min(Math.max(limitParam, 1), 50);

    // Build WHERE conditions
    const conditions = [eq(approvals.companyId, companyId)];

    // Status filter
    if (statusParam !== 'all') {
      if (statusParam === 'pending' || statusParam === 'approved' || statusParam === 'rejected') {
        conditions.push(eq(approvals.status, statusParam));
      }
    }

    // Type filter (exact match)
    if (typeParam) {
      conditions.push(eq(approvals.type, typeParam));
    }

    // Free-text search (q param) - search in payload.title, payload.summary, and note
    if (qParam) {
      const searchPattern = `%${qParam}%`;
      conditions.push(
        or(
          ilike(sql`${approvals.payload}->>'title'`, searchPattern),
          ilike(sql`${approvals.payload}->>'summary'`, searchPattern),
          ilike(approvals.note, searchPattern)
        )!
      );
    }

    // Date filters
    if (createdAfterParam) {
      const createdAfter = new Date(createdAfterParam);
      if (!isNaN(createdAfter.getTime())) {
        conditions.push(gte(approvals.createdAt, createdAfter));
      }
    }

    if (decidedAfterParam) {
      const decidedAfter = new Date(decidedAfterParam);
      if (!isNaN(decidedAfter.getTime())) {
        conditions.push(gte(approvals.decidedAt, decidedAfter));
      }
    }

    // Execute query with joins
    const rows = await db
      .select({ approval: approvals, agent: agents })
      .from(approvals)
      .leftJoin(agents, eq(approvals.requestedByAgentId, agents.id))
      .where(and(...conditions))
      .orderBy(desc(approvals.createdAt))
      .limit(limit);

    // Fetch linked issues
    const allIssueIds = [...new Set(rows.flatMap(({ approval }) => approval.issueIds ?? []))];
    const linkedIssues =
      allIssueIds.length > 0
        ? await db
            .select({
              id: issues.id,
              identifier: issues.identifier,
              title: issues.title,
              status: issues.status,
              boardApprovalId: issues.boardApprovalId,
            })
            .from(issues)
            .where(inArray(issues.id, allIssueIds))
        : [];
    const issuesById = new Map(linkedIssues.map((row) => [row.id, row]));

    // Build response
    const result = rows.map(({ approval, agent }) => ({
      id: approval.id,
      companyId: approval.companyId,
      type: approval.type,
      status: approval.status,
      requestedByAgentId: approval.requestedByAgentId,
      decidedByUserId: approval.decidedByUserId,
      issueIds: approval.issueIds,
      payload: approval.payload,
      note: approval.note,
      decidedAt: approval.decidedAt,
      hitlyApprovalId: approval.hitlyApprovalId,
      hitlyError: approval.hitlyError,
      createdAt: approval.createdAt,
      updatedAt: approval.updatedAt,
      requester: agent ? { id: agent.id, name: agent.name, urlKey: agent.urlKey } : null,
      linkedIssues: (approval.issueIds ?? [])
        .map((id) => issuesById.get(id))
        .filter((row): row is NonNullable<typeof row> => Boolean(row)),
    }));

    return NextResponse.json({ approvals: result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to list approvals';
    console.error('[GET /approvals] error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
