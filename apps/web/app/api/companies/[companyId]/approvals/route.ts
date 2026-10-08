import { NextRequest, NextResponse } from 'next/server';
import { db, approvals, approvalResumeTokens, issues, activityLog, companies, agents, type IssueStatus } from '@tourbillon/db';
import { and, eq, inArray, desc, gte, or, ilike, sql } from 'drizzle-orm';
import { authenticateAgentToken } from '@/lib/auth/agent-token-auth';
import { parseCompanySettings, resolveHitlyGate, publicOriginFromRequest } from '@tourbillon/shared';
import { ingestHitlyApproval, type HitlyIngestPayload } from '@/lib/hitly/client';
import {
  generateResumeToken,
  hashResumeToken,
  resumeTokenExpiry,
  RESUME_TOKEN_QUERY_PARAM,
} from '@/lib/hitly/resume-token';
import {
  companySettingsSecretValues,
  serializeApproval,
  stripReservedPayloadKeys,
} from '@/lib/approval-serializer';

type ApprovalPayload = Record<string, unknown> & {
  title?: string;
  summary?: string;
  priorStatuses?: Record<string, IssueStatus>;
};

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

  // The requester is always the authenticated agent (already bound to this company).
  if (body.requestedByAgentId !== undefined && body.requestedByAgentId !== runCtx.agentId) {
    return NextResponse.json(
      { error: 'requestedByAgentId must be the calling agent' },
      { status: 403 },
    );
  }
  const requestedByAgentId = runCtx.agentId;

  const issueIds = [...new Set((body.issueIds ?? []).filter(Boolean))];
  const basePayload: ApprovalPayload = stripReservedPayloadKeys(body.payload);

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
          requestedByAgentId,
          issueIds,
          payload,
        })
        .returning();

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
      let resumeToken: string | undefined;
      try {
        // Only the digest is stored, before HITLy can call back.
        resumeToken = generateResumeToken();
        await db.insert(approvalResumeTokens).values({
          approvalId: approval.id,
          tokenHash: hashResumeToken(approval.id, resumeToken),
          expiresAt: resumeTokenExpiry(),
        });
        const resumeUrl = new URL(
          `/api/approvals/${approval.id}/hitly-resume`,
          hitlyGate.resumeHost,
        );
        // HITLy's http plugin POSTs to this URL as given (no custom headers or signature).
        resumeUrl.searchParams.set(RESUME_TOKEN_QUERY_PARAM, resumeToken);
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

        // Store HITLy approval id
        await db
          .update(approvals)
          .set({
            hitlyApprovalId,
            updatedAt: new Date(),
          })
          .where(eq(approvals.id, approval.id));

        approval.hitlyApprovalId = hitlyApprovalId;
      } catch (hitlyErr: unknown) {
        // Fail-closed: store error but keep approval pending
        const rawErrorMsg =
          hitlyErr instanceof Error ? hitlyErr.message : 'Unknown HITLy ingest error';
        // The error text may quote the request back; never log or store the resume credential.
        const errorMsg = resumeToken ? rawErrorMsg.split(resumeToken).join('[redacted]') : rawErrorMsg;
        console.error('[createApproval] HITLy ingest failed:', errorMsg);
        await db
          .delete(approvalResumeTokens)
          .where(eq(approvalResumeTokens.approvalId, approval.id))
          .catch(() => {});

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

    return NextResponse.json(
      serializeApproval(approval, { knownSecrets: companySettingsSecretValues(company.settings) }),
      { status: 201 },
    );
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

    const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
    const knownSecrets = companySettingsSecretValues(company?.settings);

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
      ...serializeApproval(approval, { knownSecrets }),
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
