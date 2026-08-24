import { NextRequest, NextResponse } from 'next/server';
import { db, approvals, issues, activityLog, companies, type IssueStatus } from '@tourbillon/db';
import { and, eq, inArray } from 'drizzle-orm';
import { validateRunToken } from '@/lib/auth/run-token';
import { parseCompanySettings, resolveHitlyGate } from '@tourbillon/shared';
import { ingestHitlyApproval, type HitlyIngestPayload } from '@/lib/hitly/client';
import { randomBytes } from 'crypto';

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
  const runCtx = validateRunToken(token);
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
          `/api/approvals/${approval.id}/hitly-resume/${resumeToken}`,
          req.url,
        ).toString();

        const approvalUrl = new URL(`/approval`, req.url).toString();
        
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
          resumeUrl,
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
