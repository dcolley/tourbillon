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
  return updated ?? null;
}
