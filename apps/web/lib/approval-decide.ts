/**
 * APR-FIX: apply one decision to one approval. Shared by every decide path:
 * - Board decide (`/api/approvals/:id/decide`)
 * - HITLy callback (`/api/approvals/:id/hitly-resume`)
 * - MCP `decide_approval`
 *
 * The approval row is claimed with a conditional update (`status = 'pending'`, same company) inside
 * the transaction. Only the call that claims the row restores the linked issues, writes the
 * comments and activity, and wakes agents. A call that loses the claim (the approval was decided
 * in the meantime) gets `{ applied: false }` and has no side effects; each route maps that onto its
 * existing "already decided" response.
 *
 * APR-2: the same claim writes the `hitl/response/v0` (status, value, reason, decidedBy, activity)
 * and appends the hash-chained `decided` event, so the response and its side effects belong to the
 * one call that won. A decision other than expiry also requires the deadline not to have passed;
 * the expiry sweep (`approval-expiry.ts`) uses this same function with `outcome: 'expired'`, so a
 * decide racing an expiry has exactly one winner.
 *
 * Extension points for path-specific checks (keep them here so every path shares one claim):
 * - `approvalWhere`: extra conditions ANDed into the claim (e.g. a resume-token check).
 * - `approvalSet`: extra columns written by the claim (e.g. clearing a one-time token).
 */
import { db, approvals, activityLog, type Approval, type NewApproval } from '@tourbillon/db';
import { approvalTitleOf, newActivityCorrelationId } from './activity-correlation';
import { and, eq, gt, isNull, or, type SQL } from 'drizzle-orm';
import type { ApprovalOutcomeStatus } from '@tourbillon/shared';
import type { HitlDecidedBy, HitlResponse } from '@tourbillon/shared/hitl';
import {
  answerTypeOf,
  appendHitlEvent,
  buildHitlResponse,
  loadHitlEvents,
  restoreEffectOf,
  wakeResponseOf,
} from './hitl-host';
import { addIssueComment } from '@/lib/issue-comments';
import { formatApprovalDecisionComment, type ApprovalDecision, type IssueRestoreOutcome } from './approval-restore';
import {
  restoreLinkedIssuesForDecision,
  wakeAgentsForDecision,
  type ApprovalWakeResult,
  type DecisionActor,
} from './approval-restore-db';

export interface ApplyApprovalDecisionInput {
  companyId: string;
  approvalId: string;
  /**
   * Stored status to write (APR-2). Defaults to `decision`. `answered` restores issues like an
   * approval; `declined`, `cancelled` and `expired` keep them blocked like a rejection.
   */
  outcome?: ApprovalOutcomeStatus;
  /** Issue-restore effect. Optional when `outcome` is set (derived from it). */
  decision?: ApprovalDecision;
  note?: string;
  /** APR-2 response fields. `value` defaults to approve / reject for binary outcomes. */
  hitl?: { value?: unknown; reason?: string; decidedBy?: HitlDecidedBy };
  /** approvals.decided_by_user_id, when the path records one (e.g. 'hitly', 'mcp'). */
  decidedByUserId?: string;
  /** Actor on the `issue.updated` / wake activity rows. */
  actor: DecisionActor;
  /** Author of the decision comment on each linked issue. */
  commentAuthor: { type: 'agent' | 'user'; id: string; name?: string };
  /** Label at the start of the decision comment, e.g. 'Board'. */
  source: string;
  logPrefix: string;
  /** Extra conditions for the claim; all must hold for the decision to apply. */
  approvalWhere?: SQL[];
  /** Extra columns written with the decision. Cannot override status/note/decidedAt. */
  approvalSet?: Partial<NewApproval>;
}

export type ApplyApprovalDecisionResult =
  | {
      applied: true;
      approval: Approval;
      response: HitlResponse;
      outcomes: IssueRestoreOutcome[];
      wakes: ApprovalWakeResult[];
    }
  | { applied: false };

type ApprovalPayload = Record<string, unknown> & {
  title?: unknown;
  priorStatuses?: Record<string, unknown>;
};

const OUTCOME_LABEL: Record<ApprovalOutcomeStatus, string> = {
  approved: 'Approved',
  rejected: 'Rejected',
  answered: 'Answered',
  declined: 'Declined',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

export async function applyApprovalDecision(input: ApplyApprovalDecisionInput): Promise<ApplyApprovalDecisionResult> {
  const outcome: ApprovalOutcomeStatus = input.outcome ?? input.decision ?? 'rejected';
  const decision: ApprovalDecision = input.decision ?? restoreEffectOf(outcome);
  const closesOnDeadline = outcome === 'expired' || outcome === 'cancelled';
  // ACT-1: every activity row this decision writes (decision, restores, comments, wakes) shares it.
  const correlationId = newActivityCorrelationId();
  const claimed = await db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .update(approvals)
      .set({
        ...(input.approvalSet ?? {}),
        status: outcome,
        note: input.note,
        decidedAt: now,
        updatedAt: now,
        ...(input.decidedByUserId ? { decidedByUserId: input.decidedByUserId } : {}),
      })
      .where(
        and(
          eq(approvals.id, input.approvalId),
          eq(approvals.companyId, input.companyId),
          eq(approvals.status, 'pending'),
          // A decision after the deadline loses to the expiry sweep (APR-2).
          ...(closesOnDeadline ? [] : [or(isNull(approvals.deadline), gt(approvals.deadline, now)) as SQL]),
          ...(input.approvalWhere ?? []),
        ),
      )
      .returning();

    // Lost the claim: someone else decided it first (or an extra condition failed).
    if (!row) return null;

    // APR-2: response + `decided` event, written by the winner inside the same transaction.
    if (outcome !== 'expired') {
      await appendHitlEvent(tx, {
        companyId: input.companyId,
        approvalId: input.approvalId,
        type: 'decided',
        actor: input.hitl?.decidedBy
          ? { kind: input.hitl.decidedBy.kind, id: input.hitl.decidedBy.id }
          : { kind: 'service', id: input.actor.actorId },
        at: now,
      });
    }
    const events = await loadHitlEvents(tx, input.companyId, input.approvalId);
    const response = buildHitlResponse({
      approval: row,
      outcome,
      value: input.hitl?.value,
      reason: input.hitl ? input.hitl.reason : input.note,
      decidedBy: input.hitl?.decidedBy,
      decidedAt: now,
      events,
    });
    await tx
      .update(approvals)
      .set({ hitlResponse: response })
      .where(and(eq(approvals.id, input.approvalId), eq(approvals.companyId, input.companyId)));

    const payload = (row.payload ?? {}) as ApprovalPayload;
    const outcomes = await restoreLinkedIssuesForDecision(tx, {
      companyId: input.companyId,
      approvalId: input.approvalId,
      decision,
      priorStatuses: payload.priorStatuses,
      issueIds: row.issueIds ?? [],
      note: input.note,
      activityActor: input.actor,
      correlationId,
    });

    // ACT-1: the decision itself, on the approval's own activity (written by the winner only).
    const reason = input.hitl ? input.hitl.reason : input.note;
    // Same masked text the issue comments use (a secret answer is never written).
    const answer = answerTextForComment(response, answerTypeOf(row));
    await tx.insert(activityLog).values({
      companyId: input.companyId,
      actorType: input.actor.actorType ?? 'system',
      actorId: input.actor.actorId,
      actorName: input.actor.actorName,
      action: 'approval.decided',
      entityType: 'approval',
      entityId: input.approvalId,
      details: {
        title: approvalTitleOf(row),
        type: row.type,
        status: outcome,
        decision,
        ...(reason ? { reason } : {}),
        ...(input.note && input.note !== reason ? { note: input.note } : {}),
        ...(answer ? { answer } : {}),
        source: input.source,
        decidedBy: input.decidedByUserId ?? input.hitl?.decidedBy?.id ?? input.actor.actorId,
        // Only this company's linked issues (the restore never reads another company's).
        issueIds: outcomes.map((o) => o.issueId),
        changes: { status: { from: 'pending', to: outcome } },
      },
      correlationId,
    });
    return { row: { ...(row as Approval), hitlResponse: response } as Approval, outcomes, response };
  });

  if (!claimed) return { applied: false };
  const { row, outcomes, response } = claimed;
  const answerType = answerTypeOf(row);
  const label = OUTCOME_LABEL[outcome];
  const answer = answerTextForComment(response, answerType);
  const payload = (row.payload ?? {}) as ApprovalPayload;
  const question = (row.hitlRequest as { question?: unknown } | null)?.question;
  const title =
    typeof payload.title === 'string' ? payload.title : typeof question === 'string' ? question : row.type;
  const issueIds = row.issueIds ?? [];

  // Comment only on linked issues loaded for this company (outcomes are company-scoped).
  for (const outcome of outcomes) {
    try {
      await addIssueComment(
        outcome.issueId,
        input.companyId,
        input.commentAuthor,
        formatApprovalDecisionComment({
          source: input.source,
          decision,
          label,
          answer,
          title,
          note: input.note,
          outcome,
        }),
        undefined,
        { correlationId },
      );
    } catch (err) {
      console.error(`${input.logPrefix} failed to comment on issue`, outcome.issueId, err);
    }
  }

  // Wake the requester and the assignees of unblocked issues (non-fatal if the scheduler is down).
  const wakes = await wakeAgentsForDecision({
    companyId: input.companyId,
    approvalId: input.approvalId,
    decision,
    outcome,
    response: wakeResponseOf(response, answerType),
    note: input.note,
    issueIds,
    requesterAgentId: row.requestedByAgentId,
    outcomes,
    actor: input.actor,
    logPrefix: input.logPrefix,
    correlationId,
  });

  return { applied: true, approval: row, response, outcomes, wakes };
}

/** Short answer text for issue comments (non-binary answers only; never a secret). */
function answerTextForComment(response: HitlResponse, answerType: string): string | undefined {
  if (response.status !== 'answered' || answerType === 'binary') return undefined;
  if (answerType === 'secret') return '(encrypted secret)';
  const text = JSON.stringify(response.value) ?? '';
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}
