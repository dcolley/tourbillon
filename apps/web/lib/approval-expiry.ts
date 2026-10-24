/**
 * APR-2: expiry sweep. Closes pending approvals whose deadline has passed as `expired`, through the
 * same `applyApprovalDecision` claim every decide path uses, so a decide racing an expiry has
 * exactly one winner and the loser has no side effects. Expired responses carry no value, decidedBy
 * or decidedAt; the requester is woken and told.
 *
 * Runs lazily: approval list/detail loads and the decide paths call it for the company they serve.
 */
import { db, approvals } from '@tourbillon/db';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { applyApprovalDecision } from './approval-decide';

export const EXPIRY_ACTOR = { actorId: 'deadline', actorName: 'Deadline' } as const;

/** Expire one approval if it is pending and past its deadline. True when this call expired it. */
export async function expireApprovalIfDue(companyId: string, approvalId: string, now = new Date()): Promise<boolean> {
  const result = await applyApprovalDecision({
    companyId,
    approvalId,
    outcome: 'expired',
    actor: EXPIRY_ACTOR,
    commentAuthor: { type: 'user', id: EXPIRY_ACTOR.actorId, name: EXPIRY_ACTOR.actorName },
    source: 'Deadline',
    logPrefix: '[approval-expiry]',
    approvalWhere: [isNotNull(approvals.deadline), lte(approvals.deadline, now)],
  });
  return result.applied;
}

/** Expire every due approval in one company (bounded per call). Returns the ids this call expired. */
export async function expireDueApprovals(companyId: string, opts: { now?: Date; limit?: number } = {}): Promise<string[]> {
  const now = opts.now ?? new Date();
  let due: Array<{ id: string }>;
  try {
    due = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, companyId),
          eq(approvals.status, 'pending'),
          isNotNull(approvals.deadline),
          lte(approvals.deadline, now),
        ),
      )
      .limit(opts.limit ?? 25);
  } catch (err) {
    console.error('[approval-expiry] sweep query failed', err);
    return [];
  }
  const expired: string[] = [];
  for (const { id } of due) {
    try {
      if (await expireApprovalIfDue(companyId, id, now)) expired.push(id);
    } catch (err) {
      console.error('[approval-expiry] failed to expire approval', id, err);
    }
  }
  return expired;
}
