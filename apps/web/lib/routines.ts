import { db, routines } from '@tourbillon/db';
import { eq, and } from 'drizzle-orm';

export async function listRoutinesForAgent(agentId: string) {
  return db.select().from(routines).where(eq(routines.agentId, agentId));
}

export async function setRoutineEnabled(routineId: string, agentId: string, enabled: boolean) {
  const [updated] = await db
    .update(routines)
    .set({ enabled, updatedAt: new Date() })
    .where(and(eq(routines.id, routineId), eq(routines.agentId, agentId)))
    .returning();

  if (updated) {
    try {
      const { requestRoutineScheduleSync } = await import('./wake-client');
      const scheduleId = await requestRoutineScheduleSync(updated.id);
      if (scheduleId && scheduleId !== updated.mastraScheduleId) {
        await db
          .update(routines)
          .set({ mastraScheduleId: scheduleId, updatedAt: new Date() })
          .where(eq(routines.id, routineId));
        updated.mastraScheduleId = scheduleId;
      }
    } catch {
      // Scheduler reconciles Mastra schedules on boot if wake server is down.
    }
  }

  return updated ?? null;
}
