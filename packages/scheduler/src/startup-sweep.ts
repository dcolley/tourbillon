import { db as defaultDb, heartbeatRuns } from '@tourbillon/db';
import { and, eq, isNull, lt, or } from 'drizzle-orm';

export const ORPHANED_ON_RESTART_ERROR_TEXT =
  'Scheduler restarted while this run was in flight; marked failed on startup';

type UpdateDb = Pick<typeof defaultDb, 'update'>;

/**
 * Startup sweep: the scheduler is a single process and keeps run controllers in memory, so any
 * heartbeat_runs row still 'running' that has not pinged since this process booted belongs to a
 * dead worker. Mark those failed now instead of waiting for the interval stale sweep
 * (HEARTBEAT_STALE_SEC, default 90 s, first tick 30 s after boot).
 *
 * Must run before the wake server accepts work. Assumes one scheduler instance per database.
 */
export async function sweepOrphanedRunsOnStartup(
  bootTime: Date,
  database: UpdateDb = defaultDb,
): Promise<number> {
  const rows = await database
    .update(heartbeatRuns)
    .set({
      status: 'failed',
      finishedAt: new Date(),
      errorText: ORPHANED_ON_RESTART_ERROR_TEXT,
    })
    .where(
      and(
        eq(heartbeatRuns.status, 'running'),
        or(isNull(heartbeatRuns.lastSeenAt), lt(heartbeatRuns.lastSeenAt, bootTime)),
      ),
    )
    .returning({ id: heartbeatRuns.id });
  return rows.length;
}
