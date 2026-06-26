import {
  db,
  issues,
  activityLog,
  type Issue,
  CHECKOUT_LOCK_CLEAR_FIELDS,
  statusesThatReleaseCheckoutLock,
  isStaleCheckoutRun,
  releaseStaleCheckoutLocksForRun,
} from '@tourbillon/db';
import { eq } from 'drizzle-orm';

export {
  CHECKOUT_LOCK_CLEAR_FIELDS,
  statusesThatReleaseCheckoutLock,
  isStaleCheckoutRun,
  releaseStaleCheckoutLocksForRun,
};

export async function releaseIssueCheckoutLock(
  issueId: string,
  actor?: { type: 'user' | 'system'; id: string; name?: string },
): Promise<Issue> {
  const issue = await db.query.issues.findFirst({ where: eq(issues.id, issueId) });
  if (!issue) throw new Error('Issue not found.');
  if (!issue.checkoutRunId) return issue;

  const [updated] = await db
    .update(issues)
    .set({
      ...CHECKOUT_LOCK_CLEAR_FIELDS,
      updatedAt: new Date(),
    })
    .where(eq(issues.id, issueId))
    .returning();

  await db.insert(activityLog).values({
    companyId: issue.companyId,
    actorType: actor?.type ?? 'system',
    actorId: actor?.id ?? 'system',
    action: 'issue.lock_released',
    entityType: 'issue',
    entityId: issueId,
    details: {
      previousCheckoutRunId: issue.checkoutRunId,
      releasedBy: actor?.name ?? actor?.id ?? 'system',
    },
  });

  return updated;
}
