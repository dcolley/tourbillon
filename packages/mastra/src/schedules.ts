import type { Agent as AgentRecord, Routine } from '@tourbillon/db';
import type { AgentRuntimeConfig } from '@tourbillon/shared';
import { createTraceLogger, resolveHeartbeatSchedule } from '@tourbillon/shared';
import {
  ensureMastraAgentRegistered,
  getMastraInstance,
} from './mastra-instance';

const tracer = createTraceLogger('schedules-sync', {});

export function agentTimerScheduleId(agentId: string): string {
  return `timer-${agentId}`;
}

export function routineScheduleId(routineId: string): string {
  return `routine-${routineId}`;
}

/** @deprecated Import from `@tourbillon/shared` */
export { intervalSecToCron } from '@tourbillon/shared';

async function upsertAgentSchedule(input: {
  id: string;
  agentId: string;
  agentName?: string;
  cron: string;
  timezone?: string;
  prompt: string;
  metadata: Record<string, unknown>;
  enabled: boolean;
}): Promise<string> {
  const mastra = getMastraInstance();
  ensureMastraAgentRegistered(input.agentId, input.agentName);

  const existing = await mastra.schedules.get(input.id);
  if (existing && !('agentId' in existing && existing.agentId)) {
    await mastra.schedules.delete(input.id);
  }

  const current = await mastra.schedules.get(input.id);
  if (!current) {
    const created = await mastra.schedules.create({
      id: input.id,
      agentId: input.agentId,
      cron: input.cron,
      prompt: input.prompt,
      timezone: input.timezone,
      name: input.id,
      metadata: input.metadata,
      status: input.enabled ? 'active' : 'paused',
    });
    tracer.info('created schedule', { scheduleId: created.id, agentId: input.agentId });
    return created.id;
  }

  await mastra.schedules.update(input.id, {
    cron: input.cron,
    timezone: input.timezone,
    prompt: input.prompt,
    metadata: input.metadata,
    status: input.enabled ? 'active' : 'paused',
  });
  tracer.info('updated schedule', { scheduleId: input.id, agentId: input.agentId });
  return input.id;
}

export async function syncAgentTimerSchedule(agent: AgentRecord): Promise<string | null> {
  const hb = (agent.runtimeConfig as AgentRuntimeConfig | null)?.heartbeat;
  const resolved = resolveHeartbeatSchedule(hb);
  const scheduleId = agentTimerScheduleId(agent.id);

  if (!resolved.active) {
    const existing = await getMastraInstance().schedules.get(scheduleId);
    if (existing) {
      await getMastraInstance().schedules.pause(scheduleId).catch(async () => {
        await getMastraInstance().schedules.delete(scheduleId).catch(() => undefined);
      });
    }
    return null;
  }

  return upsertAgentSchedule({
    id: scheduleId,
    agentId: agent.id,
    agentName: agent.name,
    cron: resolved.cron,
    timezone: resolved.timezone,
    prompt: 'Wake reason: timer\n\nBegin your heartbeat procedure. Follow SKILL: Control Plane Operations exactly.',
    metadata: {
      ...resolved.metadata,
      tourbillonKind: 'agent-timer',
      companyId: agent.companyId,
    },
    enabled: true,
  });
}

export async function syncRoutineSchedule(routine: Routine): Promise<string> {
  const scheduleId = routineScheduleId(routine.id);
  return upsertAgentSchedule({
    id: scheduleId,
    agentId: routine.agentId,
    cron: routine.cronExpression,
    timezone: routine.timezone || 'UTC',
    prompt: `Routine: ${routine.name}`,
    metadata: {
      tourbillonKind: 'routine',
      companyId: routine.companyId,
      routineId: routine.id,
      routineName: routine.name,
      taskTemplate: routine.taskTemplate,
    },
    enabled: routine.enabled,
  });
}

export async function deleteRoutineSchedule(routineId: string): Promise<void> {
  const scheduleId = routineScheduleId(routineId);
  await getMastraInstance().schedules.delete(scheduleId).catch(() => undefined);
}

export async function reconcileAllSchedules(input: {
  agents: AgentRecord[];
  routines: Routine[];
}): Promise<void> {
  for (const agent of input.agents) {
    try {
      await syncAgentTimerSchedule(agent);
    } catch (err) {
      tracer.error('agent timer sync failed', {
        agentId: agent.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  for (const routine of input.routines) {
    try {
      await syncRoutineSchedule(routine);
    } catch (err) {
      tracer.error('routine schedule sync failed', {
        routineId: routine.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  tracer.info('reconcile complete', {
    agents: input.agents.length,
    routines: input.routines.length,
  });
}
