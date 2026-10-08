import { agents, heartbeatRuns, type DbClient } from '@tourbillon/db';
import { and, eq } from 'drizzle-orm';

type HeartbeatRunInsert = typeof heartbeatRuns.$inferInsert;
type TxRunner = Pick<DbClient, 'transaction'>;
type Updater = Pick<DbClient, 'update'>;

/**
 * Create a wake's heartbeat_runs row only while its agent is not archived. The agent row is locked
 * (SELECT … FOR UPDATE) in the same transaction as the insert, so this serialises with the board
 * archive's status update: either the run row commits first (and the archive, which looks for
 * in-flight runs after it commits, stops it), or the archive commits first and this sees
 * 'archived' and creates nothing. Returns false when refused (a skipped wake, not an error).
 */
export async function insertHeartbeatRunUnlessArchived(
  db: TxRunner,
  values: HeartbeatRunInsert,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, values.agentId), eq(agents.companyId, values.companyId)))
      .for('update');
    if (!agent || agent.status === 'archived') return false;
    await tx.insert(heartbeatRuns).values(values);
    return true;
  });
}

/**
 * Mark a run succeeded only if it is still running. A run that was cancelled (agent archived),
 * force-killed or otherwise finished while its work completed keeps its terminal status; the
 * check is part of the update itself, so it can't race with the kill. Returns whether it changed.
 */
export async function markHeartbeatRunSucceeded(
  db: Updater,
  runId: string,
  updates: {
    status: 'succeeded';
    finishedAt: Date;
    errorText: null;
    traceId?: string | undefined;
    harnessRunId?: string | undefined;
  },
): Promise<boolean> {
  const rows = await db
    .update(heartbeatRuns)
    .set(updates)
    .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, 'running')))
    .returning({ id: heartbeatRuns.id });
  return rows.length > 0;
}
