import { CronExpressionParser } from 'cron-parser';
import { db, routines } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { createTraceLogger } from '@tourbillon/shared';

const POLL_INTERVAL_MS = 60_000;
const tracer = createTraceLogger('routine-scheduler', {});

let routineTimer: ReturnType<typeof setInterval>;

export function startRoutineScheduler(): void {
  routineTimer = setInterval(fireReadyRoutines, POLL_INTERVAL_MS);
  tracer.info('started, polling every 60s', { apiBase: process.env.INTERNAL_API_URL });
}

async function fireReadyRoutines(): Promise<void> {
  const now = new Date();
  const activeRoutines = await db.query.routines.findMany({
    where: eq(routines.enabled, true),
  } as Parameters<typeof db.query.routines.findMany>[0]);

  for (const routine of activeRoutines) {
    if (!shouldFire(routine, now)) continue;
    try {
      const res = await fetch(`${process.env.INTERNAL_API_URL}/api/companies/${routine.companyId}/issues`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.SCHEDULER_API_KEY}`,
        },
        body: JSON.stringify({
          ...(routine.taskTemplate as object),
          routineId: routine.id,
          assigneeAgentId: routine.agentId,
          source: 'routine',
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Issue create failed (${res.status}): ${body}`);
      }
      const created = await res.json() as { id?: string; identifier?: string };
      await db.update(routines).set({ lastFiredAt: now }).where(eq(routines.id, routine.id));
      tracer.info('routine fired', {
        routineId: routine.id,
        routineName: routine.name,
        agentId: routine.agentId,
        issueId: created.id,
        identifier: created.identifier,
      });
    } catch (err) {
      tracer.error('routine fire failed', {
        routineId: routine.id,
        routineName: routine.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function shouldFire(
  routine: { cronExpression: string; timezone: string; lastFiredAt: Date | null },
  now: Date
): boolean {
  let prevFire: Date;
  try {
    prevFire = CronExpressionParser.parse(routine.cronExpression, {
      currentDate: now,
      tz: routine.timezone || 'UTC',
    }).prev().toDate();
  } catch {
    tracer.error('invalid cron expression', { cronExpression: routine.cronExpression });
    return false;
  }

  if (!routine.lastFiredAt) return true;
  return prevFire.getTime() > routine.lastFiredAt.getTime();
}

startRoutineScheduler();
