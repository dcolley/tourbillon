/**
 * Board 'Archive agent' (permanent).
 *
 * 1. agents.status → 'archived' and runtimeConfig.heartbeat.enabled → false in one company-scoped
 *    write, plus an `agent.archived` activity row. From then on #119's rule refuses any
 *    reactivation (setAgentActive*), #120/#123 refuses the agent's run/chat tokens (401), the
 *    scheduler skips every wake (status !== 'active') and never keeps its timer (archived →
 *    resolveAgentTimerSchedule inactive).
 * 2. Timer: ask the scheduler to re-sync the agent's Mastra timer schedule, which pauses it.
 *    Best effort: if the scheduler is down, its boot reconcile pauses it (the config is off).
 * 3. In-flight run(s) (queued/running): stopped through the scheduler's force-kill with reason
 *    'agent_archived' (aborts the run's AbortController; row → cancelled, AGENT_ARCHIVED_RUN_ERROR;
 *    checkout locks released). If the scheduler can't be reached, the row is recorded cancelled
 *    here with the same reason and its checkout locks are released; the run's token already 401s.
 *
 * Idempotent: archiving an already-archived agent writes nothing to the agent (no second
 * activity row) and reports `changed: false`; the timer/run clean-up is re-run, which is a no-op
 * when there is nothing left to stop.
 */
import {
  db,
  agents,
  activityLog,
  heartbeatRuns,
  releaseStaleCheckoutLocksForRun,
  type Agent,
} from '@tourbillon/db';
import { and, eq, inArray, ne, or } from 'drizzle-orm';
import {
  AGENT_ARCHIVED_RUN_CODE,
  AGENT_ARCHIVED_RUN_ERROR,
  DEFAULT_RUNTIME_CONFIG,
  type AgentRuntimeConfig,
} from '@tourbillon/shared';
import { invalidateChatControllerForAgent } from './chat';
import {
  requestAgentTimerScheduleSync,
  requestHeartbeatForceKill,
  type SchedulerForceKillOutcome,
} from './wake-client';

export type ArchivedRunOutcome = {
  runId: string;
  /** aborted: scheduler aborted it; recorded: scheduler unreachable, row cancelled here. */
  outcome: 'aborted' | 'recorded' | 'already_finished';
};

export interface ArchiveAgentResult {
  agent: Agent;
  /** false when the agent was already archived (idempotent no-op). */
  changed: boolean;
  /** 'synced': scheduler paused the timer now; 'deferred': scheduler down, boot reconcile pauses it. */
  timerSync: 'synced' | 'deferred';
  runs: ArchivedRunOutcome[];
}

export interface ArchiveAgentDeps {
  killRun: (runId: string, companyId: string) => Promise<SchedulerForceKillOutcome>;
  syncTimer: (agentId: string) => Promise<void>;
  invalidateChat: (agentId: string) => void;
}

const defaultDeps: ArchiveAgentDeps = {
  killRun: (runId, companyId) => requestHeartbeatForceKill(runId, companyId, AGENT_ARCHIVED_RUN_CODE),
  syncTimer: requestAgentTimerScheduleSync,
  invalidateChat: invalidateChatControllerForAgent,
};

/**
 * Archive an agent of `companyId` (looked up by id or urlKey inside that company only, so another
 * company's agent is indistinguishable from a missing one). Returns null when not found (404).
 */
export async function archiveAgent(
  agentIdOrUrlKey: string,
  companyId: string,
  deps: ArchiveAgentDeps = defaultDeps,
): Promise<ArchiveAgentResult | null> {
  const key = agentIdOrUrlKey?.trim();
  if (!key || !companyId) return null;

  const agent = await db.query.agents.findFirst({
    where: and(eq(agents.companyId, companyId), or(eq(agents.id, key), eq(agents.urlKey, key))),
  });
  if (!agent) return null;

  let current: Agent = agent;
  let changed = false;

  if (agent.status !== 'archived') {
    const runtimeConfig = (agent.runtimeConfig ?? {}) as AgentRuntimeConfig;
    const nextRuntimeConfig: AgentRuntimeConfig = {
      ...runtimeConfig,
      heartbeat: { ...(runtimeConfig.heartbeat ?? DEFAULT_RUNTIME_CONFIG.heartbeat), enabled: false },
    };
    // Guarded on status so a concurrent archive can't write twice.
    const [updated] = await db
      .update(agents)
      .set({ status: 'archived', runtimeConfig: nextRuntimeConfig, updatedAt: new Date() })
      .where(and(eq(agents.id, agent.id), eq(agents.companyId, companyId), ne(agents.status, 'archived')))
      .returning();

    if (updated) {
      current = updated;
      changed = true;
      await db.insert(activityLog).values({
        companyId,
        actorType: 'user',
        actorId: 'dashboard',
        actorName: 'Dashboard',
        action: 'agent.archived',
        entityType: 'agent',
        entityId: agent.id,
        details: {
          previousStatus: agent.status,
          heartbeatWasEnabled: Boolean(runtimeConfig.heartbeat?.enabled),
        },
      });
      deps.invalidateChat(agent.id);
    } else {
      current =
        (await db.query.agents.findFirst({
          where: and(eq(agents.id, agent.id), eq(agents.companyId, companyId)),
        })) ?? agent;
    }
  }

  let timerSync: ArchiveAgentResult['timerSync'] = 'synced';
  try {
    await deps.syncTimer(agent.id);
  } catch {
    timerSync = 'deferred';
  }

  const inFlight = await db
    .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.agentId, agent.id),
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, ['queued', 'running']),
      ),
    );

  const runs: ArchivedRunOutcome[] = [];
  for (const run of inFlight) {
    const outcome = await deps.killRun(run.id, companyId);
    if (outcome === 'aborted' || outcome === 'already_finished') {
      runs.push({ runId: run.id, outcome });
      continue;
    }
    runs.push({ runId: run.id, outcome: await recordRunCancelled(run.id) });
  }

  return { agent: current, changed, timerSync, runs };
}

/** Scheduler unreachable: record the cancellation (only if the row is still in flight). */
async function recordRunCancelled(runId: string): Promise<ArchivedRunOutcome['outcome']> {
  const rows = await db
    .update(heartbeatRuns)
    .set({ status: 'cancelled', finishedAt: new Date(), errorText: AGENT_ARCHIVED_RUN_ERROR })
    .where(and(eq(heartbeatRuns.id, runId), inArray(heartbeatRuns.status, ['queued', 'running'])))
    .returning({ id: heartbeatRuns.id });
  if (rows.length === 0) return 'already_finished';
  await releaseStaleCheckoutLocksForRun(runId).catch(() => undefined);
  return 'recorded';
}
