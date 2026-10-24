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
 * Extension points for path-specific checks (keep them here so every path shares one claim):
 * - `approvalWhere`: extra conditions ANDed into the claim (e.g. a resume-token check).
 * - `approvalSet`: extra columns written by the claim (e.g. clearing a one-time token).
 */
import { db, approvals, type Approval, type NewApproval } from '@tourbillon/db';
import { and, eq, type SQL } from 'drizzle-orm';
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
  decision: ApprovalDecision;
  note?: string;
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
  | { applied: true; approval: Approval; outcomes: IssueRestoreOutcome[]; wakes: ApprovalWakeResult[] }
  | { applied: false };

type ApprovalPayload = Record<string, unknown> & {
  title?: unknown;
  priorStatuses?: Record<string, unknown>;
};

export async function applyApprovalDecision(input: ApplyApprovalDecisionInput): Promise<ApplyApprovalDecisionResult> {
  const claimed = await db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .update(approvals)
      .set({
        ...(input.approvalSet ?? {}),
        status: input.decision,
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
          ...(input.approvalWhere ?? []),
        ),
      )
      .returning();

    // Lost the claim: someone else decided it first (or an extra condition failed).
    if (!row) return null;

    const payload = (row.payload ?? {}) as ApprovalPayload;
    const outcomes = await restoreLinkedIssuesForDecision(tx, {
      companyId: input.companyId,
      approvalId: input.approvalId,
      decision: input.decision,
      priorStatuses: payload.priorStatuses,
      issueIds: row.issueIds ?? [],
      note: input.note,
      activityActor: input.actor,
    });
    return { row: row as Approval, outcomes };
  });

  if (!claimed) return { applied: false };
  const { row, outcomes } = claimed;
  const payload = (row.payload ?? {}) as ApprovalPayload;
  const title = typeof payload.title === 'string' ? payload.title : row.type;
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
          decision: input.decision,
          title,
          note: input.note,
          outcome,
        }),
      );
    } catch (err) {
      console.error(`${input.logPrefix} failed to comment on issue`, outcome.issueId, err);
    }
  }

  // Wake the requester and the assignees of unblocked issues (non-fatal if the scheduler is down).
  const wakes = await wakeAgentsForDecision({
    companyId: input.companyId,
    approvalId: input.approvalId,
    decision: input.decision,
    note: input.note,
    issueIds,
    requesterAgentId: row.requestedByAgentId,
    outcomes,
    actor: input.actor,
    logPrefix: input.logPrefix,
  });

  return { applied: true, approval: row, outcomes, wakes };
}
