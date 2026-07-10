import { db, agents, routines } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import {
  initMastraStorage,
  setScheduleWakeInvoker,
  reconcileAllSchedules,
  getInternalApiUrl,
  getMastraInstance,
} from '@tourbillon/mastra';
import { createTraceLogger } from '@tourbillon/shared';
import { triggerWake } from './wake-runner';

const tracer = createTraceLogger('schedule-boot', {});

async function fireRoutineIssue(meta: Record<string, unknown>): Promise<{
  issueId?: string;
  companyId: string;
  agentId: string;
}> {
  const companyId = String(meta.companyId ?? '');
  const agentId = String(meta.agentId ?? meta.agent_id ?? '');
  const routineId = String(meta.routineId ?? '');
  const taskTemplate = (meta.taskTemplate ?? {}) as Record<string, unknown>;

  if (!companyId || !agentId || !routineId) {
    throw new Error('routine fire missing companyId/agentId/routineId');
  }

  const res = await fetch(`${getInternalApiUrl()}/api/companies/${companyId}/issues`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.SCHEDULER_API_KEY}`,
    },
    body: JSON.stringify({
      ...taskTemplate,
      routineId,
      assigneeAgentId: agentId,
      source: 'routine',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Issue create failed (${res.status}): ${body}`);
  }
  const created = (await res.json()) as { id?: string };
  await db.update(routines).set({ lastFiredAt: new Date() }).where(eq(routines.id, routineId));
  return { issueId: created.id, companyId, agentId };
}

export async function bootMastraSchedules(): Promise<void> {
  await initMastraStorage();

  setScheduleWakeInvoker(async ({ agentId, companyId, wakeReason, taskId, metadata }) => {
    if (wakeReason === 'assignment' && metadata?.tourbillonKind === 'routine') {
      // Issue create API enqueues the assignment wake; do not trigger twice.
      await fireRoutineIssue({
        ...metadata,
        agentId,
        companyId,
      });
      return;
    }

    await triggerWake({
      agentId,
      companyId,
      invocationSource: wakeReason,
      wakeReason,
      taskId,
    });
  });

  const [allAgents, allRoutines] = await Promise.all([
    db.query.agents.findMany(),
    db.query.routines.findMany(),
  ]);

  // Persist mastraScheduleId on routines that lack it.
  for (const routine of allRoutines) {
    if (!routine.mastraScheduleId) {
      await db
        .update(routines)
        .set({ mastraScheduleId: `routine-${routine.id}`, updatedAt: new Date() })
        .where(eq(routines.id, routine.id));
    }
  }

  await reconcileAllSchedules({ agents: allAgents, routines: allRoutines });

  const mastra = getMastraInstance();
  await mastra.startWorkers();
  tracer.info('Mastra scheduling workers started');

  tracer.info('Mastra schedules booted', {
    agents: allAgents.length,
    routines: allRoutines.length,
  });
}
