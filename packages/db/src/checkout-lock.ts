import { db } from './client';
import { issues } from './schema/issues';
import { heartbeatRuns, type HeartbeatStatus } from './schema/heartbeat-runs';
import { eq } from 'drizzle-orm';

const TERMINAL_HEARTBEAT_STATUSES = new Set<HeartbeatStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'coalesced',
]);

export const CHECKOUT_LOCK_CLEAR_FIELDS = {
  checkoutRunId: null,
  executionLockedAt: null,
  executionAgentNameKey: null,
} as const;

export function statusesThatReleaseCheckoutLock(status: string): boolean {
  return ['done', 'cancelled', 'blocked', 'in_review', 'todo', 'backlog'].includes(status);
}

export async function isStaleCheckoutRun(runId: string | null | undefined): Promise<boolean> {
  if (!runId) return false;
  const run = await db.query.heartbeatRuns.findFirst({
    where: eq(heartbeatRuns.id, runId),
  });
  if (!run) return true;
  return TERMINAL_HEARTBEAT_STATUSES.has(run.status);
}

export async function releaseStaleCheckoutLocksForRun(runId: string): Promise<number> {
  const locked = await db.query.issues.findMany({
    where: eq(issues.checkoutRunId, runId),
    columns: { id: true },
  });

  if (locked.length === 0) return 0;

  await db
    .update(issues)
    .set({
      ...CHECKOUT_LOCK_CLEAR_FIELDS,
      updatedAt: new Date(),
    })
    .where(eq(issues.checkoutRunId, runId));

  return locked.length;
}
