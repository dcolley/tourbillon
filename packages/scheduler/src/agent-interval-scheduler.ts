import { db, agents, heartbeatRuns } from '@tourbillon/db';
import { and, eq, desc } from 'drizzle-orm';
import type { AgentRuntimeConfig } from '@tourbillon/shared';
import { createTraceLogger } from '@tourbillon/shared';
import Redlock from 'redlock';
import { enqueueHeartbeat } from './heartbeat-queue';
import { createConnection } from './redis';

const tracer = createTraceLogger('agent-interval', {});

const POLL_INTERVAL_MS = 30_000;
const LOCK_KEY = 'lock:agent-interval-scheduler';
const LOCK_TTL_MS = POLL_INTERVAL_MS - 5000;

const lockRedis = createConnection();
const redlock = new Redlock([lockRedis], { retryCount: 0 });

let intervalTimer: ReturnType<typeof setInterval>;

export function startAgentIntervalScheduler(): void {
  void fireDueAgentHeartbeats();
  intervalTimer = setInterval(fireDueAgentHeartbeats, POLL_INTERVAL_MS);
  tracer.info(`started, polling every ${POLL_INTERVAL_MS / 1000}s`);
}

async function fireDueAgentHeartbeats(): Promise<void> {
  let lock;
  try {
    lock = await redlock.acquire([LOCK_KEY], LOCK_TTL_MS);
  } catch {
    return;
  }

  try {
    const now = Date.now();
    const activeAgents = await db.select().from(agents).where(eq(agents.status, 'active'));

    for (const agent of activeAgents) {
      const runtime = agent.runtimeConfig as AgentRuntimeConfig;
      const heartbeat = runtime.heartbeat;
      if (!heartbeat?.enabled || heartbeat.intervalSec <= 0) continue;

      const lastTimerRun = await db.query.heartbeatRuns.findFirst({
        where: and(
          eq(heartbeatRuns.agentId, agent.id),
          eq(heartbeatRuns.invocationSource, 'timer')
        ),
        orderBy: desc(heartbeatRuns.startedAt),
      });

      const lastAt = lastTimerRun?.startedAt?.getTime() ?? 0;
      if (now - lastAt < heartbeat.intervalSec * 1000) continue;

      try {
        const { jobId, outcome } = await enqueueHeartbeat({
          agentId: agent.id,
          companyId: agent.companyId,
          invocationSource: 'timer',
          wakeReason: 'timer',
        });
        tracer.info(`timer heartbeat ${outcome}`, {
          agentId: agent.id,
          agentName: agent.name,
          urlKey: agent.urlKey,
          heartbeatJobId: jobId,
          outcome,
          intervalSec: heartbeat.intervalSec,
          lastTimerRunAt: lastTimerRun?.startedAt?.toISOString(),
        });
      } catch (err) {
        tracer.error('failed to enqueue timer heartbeat', {
          agentId: agent.id,
          urlKey: agent.urlKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    await lock.release().catch(() => undefined);
  }
}

startAgentIntervalScheduler();
