import { and, eq, sql } from 'drizzle-orm';
import { db } from './client';
import { heartbeatRuns } from './schema/heartbeat-runs';
import { releaseStaleCheckoutLocksForRun } from './checkout-lock';

/**
 * Mark running heartbeat_runs linked to a BullMQ job id as failed.
 * Returns reconciled run ids.
 */
export async function reconcileRunningHeartbeatRunsForJob(
  jobId: string,
  errorText: string,
): Promise<string[]> {
  const updated = await db
    .update(heartbeatRuns)
    .set({
      status: 'failed',
      errorText,
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(heartbeatRuns.status, 'running'),
        sql`context_snapshot->>'jobId' = ${jobId}`,
      ),
    )
    .returning({ id: heartbeatRuns.id });

  for (const row of updated) {
    await releaseStaleCheckoutLocksForRun(row.id);
  }

  return updated.map((row) => row.id);
}
