import { NextRequest, NextResponse } from 'next/server';
import { db, approvals, approvalResumeTokens, issues, activityLog, type Approval, type IssueStatus } from '@tourbillon/db';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { enqueueApprovalWake } from '@/lib/wake-client';
import { addIssueComment } from '@/lib/issue-comments';
import type { HitlyResumePayload } from '@/lib/hitly/client';
import { hashResumeToken, readResumeCredential, resumeTokenMatches } from '@/lib/hitly/resume-token';

type ApprovalPayload = Record<string, unknown> & {
  title?: string;
  summary?: string;
  priorStatuses?: Record<string, IssueStatus>;
  hitlyResumeToken?: string;
};

class ResumeConflict extends Error {}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ approvalId: string }> }
) {
  const { approvalId } = await params;

  // Called by HITLy via the resumeUrl given at ingest (see lib/hitly/resume-token.ts).
  // TODO: drop the ?token= query form once the HITLy http plugin signs resume callbacks (header/HMAC).
  const credential = readResumeCredential(req);
  if (!credential.ok) {
    return NextResponse.json({ error: credential.error }, { status: credential.status });
  }
  const token = credential.token;

  let body: HitlyResumePayload;
  try {
    const parsed = (await req.json()) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as HitlyResumePayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { decision, metadata, id: hitlyId } = body;

  // Load approval
  const approval = await db.query.approvals.findFirst({
    where: eq(approvals.id, approvalId),
  });

  if (!approval) {
    return NextResponse.json({ error: 'Approval not found' }, { status: 404 });
  }

  const payload = (approval.payload ?? {}) as ApprovalPayload;

  // Validate resume token: digest bound to this approval, constant-time compare.
  const stored = await db.query.approvalResumeTokens.findFirst({
    where: eq(approvalResumeTokens.approvalId, approvalId),
  });
  if (!stored) {
    if (typeof payload.hitlyResumeToken === 'string') {
      // Issued before digests were stored: no longer honoured; decide in Tourbillon instead.
      return NextResponse.json({ error: 'Resume link expired' }, { status: 410 });
    }
    return NextResponse.json({ error: 'Invalid resume token' }, { status: 401 });
  }
  if (!resumeTokenMatches(approvalId, token, stored.tokenHash)) {
    console.error('[hitly-resume] Invalid resume token', { approvalId });
    return NextResponse.json({ error: 'Invalid resume token' }, { status: 401 });
  }
  if (stored.usedAt) {
    return NextResponse.json({ error: 'Resume token already used' }, { status: 409 });
  }
  if (!(stored.expiresAt instanceof Date) || stored.expiresAt.getTime() <= Date.now()) {
    return NextResponse.json({ error: 'Resume link expired' }, { status: 410 });
  }

  // Validate HITLy approval id if provided
  if (hitlyId && approval.hitlyApprovalId && approval.hitlyApprovalId !== hitlyId) {
    console.error('[hitly-resume] HITLy id mismatch', {
      approvalId,
      expected: approval.hitlyApprovalId,
      received: hitlyId,
    });
    return NextResponse.json({ error: 'HITLy id mismatch' }, { status: 400 });
  }

  // Map HITLy decision to Tourbillon status
  let tourbillonStatus: 'approved' | 'rejected' | null = null;
  let note = '';

  if (decision === 'accept') {
    tourbillonStatus = 'approved';
    note = metadata?.note ? String(metadata.note) : 'Approved via HITLy';
  } else if (decision === 'reject') {
    tourbillonStatus = 'rejected';
    note = metadata?.note ? String(metadata.note) : 'Rejected via HITLy';
  } else {
    // Unknown decision — fail closed: stay pending, log error
    const errorMsg = `HITLy returned unsupported decision: ${decision}`;
    console.error('[hitly-resume]', errorMsg, { approvalId, hitlyId, decision });
    
    await db
      .update(approvals)
      .set({
        hitlyError: errorMsg,
        updatedAt: new Date(),
      })
      .where(eq(approvals.id, approvalId));

    return NextResponse.json({ error: errorMsg }, { status: 400 });
  }

  // Apply decision with same side effects as in-app decide
  const priorStatuses = payload.priorStatuses ?? {};
  const issueIds = approval.issueIds ?? [];

  const tokenHash = hashResumeToken(approvalId, token);
  let updated: Approval | undefined;
  try {
    updated = await db.transaction(async (tx) => {
      // Single use: only one request can flip used_at for a live, matching digest.
      const now = new Date();
      const consumed = await tx
        .update(approvalResumeTokens)
        .set({ usedAt: now })
        .where(
          and(
            eq(approvalResumeTokens.approvalId, approvalId),
            eq(approvalResumeTokens.tokenHash, tokenHash),
            isNull(approvalResumeTokens.usedAt),
            gt(approvalResumeTokens.expiresAt, now),
          ),
        )
        .returning();
      if (consumed.length === 0) throw new ResumeConflict('Resume token already used');

      const [row] = await tx
        .update(approvals)
        .set({
          status: tourbillonStatus,
          note,
          decidedAt: now,
          decidedByUserId: 'hitly',
          updatedAt: now,
        })
        .where(and(eq(approvals.id, approvalId), eq(approvals.status, 'pending')))
        .returning();
      // Already decided in Tourbillon: the token is spent, nothing else changes.
      if (!row) return undefined;

      if (issueIds.length > 0) {
        const linked = await tx
          .select({ id: issues.id, status: issues.status, boardApprovalId: issues.boardApprovalId })
          .from(issues)
          .where(and(eq(issues.companyId, approval.companyId), inArray(issues.id, issueIds)));

        for (const issue of linked) {
          // Only clear halt for issues still bound to this approval
          if (issue.boardApprovalId && issue.boardApprovalId !== approvalId) continue;

          const restoreStatus =
            tourbillonStatus === 'approved'
              ? (priorStatuses[issue.id] ?? (issue.status === 'blocked' ? 'todo' : issue.status))
              : 'blocked';

          await tx
            .update(issues)
            .set({
              status: restoreStatus,
              boardApprovalId: null,
              updatedAt: now,
            })
            .where(eq(issues.id, issue.id));

          await tx.insert(activityLog).values({
            companyId: approval.companyId,
            actorType: 'system',
            actorId: 'hitly',
            actorName: 'HITLy',
            action: 'issue.updated',
            entityType: 'issue',
            entityId: issue.id,
            details: {
              status: restoreStatus,
              boardApprovalId: null,
              approvalId,
              decision: tourbillonStatus,
              note,
            },
          });
        }
      }

      return row;
    });
  } catch (err) {
    if (err instanceof ResumeConflict) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }

  if (!updated) {
    return NextResponse.json({ status: 'ok', alreadyDecided: true });
  }

  const decisionLabel = tourbillonStatus === 'approved' ? 'Approved' : 'Rejected';
  const title = typeof payload.title === 'string' ? payload.title : approval.type;
  const commentBody = [
    `**HITLy ${decisionLabel}:** ${title}`,
    note ? `Note: ${note}` : null,
    tourbillonStatus === 'approved'
      ? 'Linked issues have been unhalted (status restored). Continue work if still assigned.'
      : 'Linked issues remain blocked. Triage, revise the request, or cancel as appropriate.',
  ]
    .filter(Boolean)
    .join('\n');

  for (const issueId of issueIds) {
    try {
      await addIssueComment(
        issueId,
        approval.companyId,
        { type: 'user', id: 'hitly', name: 'HITLy' },
        commentBody,
      );
    } catch (err) {
      console.error('[hitly-resume] failed to comment on issue', issueId, err);
    }
  }

  // Trigger WakeRunner for the requesting agent (non-fatal if scheduler is down)
  if (approval.requestedByAgentId) {
    try {
      await enqueueApprovalWake({
        approvalId: approvalId,
        agentId: approval.requestedByAgentId,
        companyId: approval.companyId,
        status: tourbillonStatus,
        note,
        linkedIssueIds: approval.issueIds,
      });
    } catch (err) {
      console.error('[hitly-resume] failed to trigger approval wake:', err);
    }
  }

  return NextResponse.json({ status: 'ok', decision: tourbillonStatus });
}
