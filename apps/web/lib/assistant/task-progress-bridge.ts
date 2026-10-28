/**
 * CONCIERGE-QUEUE-SIGNAL: real subscriber wiring for the TASK-RUNNER → free-chat bridge.
 *
 * Runs once per web server process (started from instrumentation.ts). Pattern-subscribes the
 * company SSE channels, filters `chat_task_progress` events published by the scheduler's
 * TASK-RUNNER poller, and queues each one as a typed reactive `task-progress` signal on the
 * agent's PINNED free-chat thread — reusing the SAME AgentController session the dashboard
 * chat uses, so the signal shares the queue with the human's queued follow-ups (Mastra
 * ordering: idle → wakes the thread now; active → delivered after the current run).
 *
 * Heartbeats and the existing SSE chip path are untouched: this is an extra consumer of the
 * event the scheduler already publishes (no parallel notification bus — product lock).
 */
import IORedis from 'ioredis';
import { and, eq } from 'drizzle-orm';
import { db, agents, type Agent } from '@tourbillon/db';
import { chatResourceId, getChatSession, getOrCreateChatController } from '@/lib/chat';
import { aguiSessionScope } from '@/lib/agui/run-input';
import { getActiveAssistantThreadId } from '@/lib/assistant/thread-store';
import {
  handleTaskProgressEvent,
  parseTaskProgressMessage,
  queueTaskProgressSignal,
  type TaskProgressBridgeDeps,
} from './task-progress-signals';
import type { TaskProgressSignalPayload } from '../../../../packages/mastra/src/concierge-signal';

async function getAgent(agentId: string): Promise<Agent | null> {
  const row = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  return row ?? null;
}

/**
 * Queue one payload on the agent's free-chat AG-UI session (the one the dashboard uses:
 * resourceId = company free-chat, scope = agui:<agentId>). An idle session on another thread
 * is moved onto the pinned thread first (same rule as Clear-chat retargeting); a session busy
 * on another thread is left alone — hijacking a live run's thread is not what progress is for.
 */
async function deliver(agent: Agent, threadId: string, payload: TaskProgressSignalPayload): Promise<boolean> {
  const resourceId = chatResourceId(agent.companyId);
  const scope = aguiSessionScope(agent);
  const controller = await getOrCreateChatController(agent);
  let session = await controller.getSessionByResource(resourceId, scope);
  if (!session) {
    session = await getChatSession(controller, agent, { resourceId, scope, threadId });
  } else if (session.thread.getId() !== threadId) {
    if (session.getCurrentRunId()) return false;
    await session.thread.switch({ threadId });
  }
  await queueTaskProgressSignal(session, payload);
  return true;
}

const bridgeDeps: TaskProgressBridgeDeps<Agent> = {
  getAgent,
  getActiveThreadId: (scope) => getActiveAssistantThreadId(scope),
  deliver,
  log: { warn: (msg, data) => console.warn(msg, data ?? '') },
};

const globalForBridge = globalThis as unknown as {
  tourbillonTaskProgressBridge?: { started: boolean };
};

/** Start the redis → queueSignal bridge (idempotent per process). */
export function startTaskProgressSignalBridge(): void {
  if (globalForBridge.tourbillonTaskProgressBridge) return;
  globalForBridge.tourbillonTaskProgressBridge = { started: true };

  const sub = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
    if (!channel.startsWith('sse:')) return;
    const event = parseTaskProgressMessage(message);
    if (!event) return;
    void handleTaskProgressEvent(bridgeDeps, event).catch((err) => {
      console.warn('[concierge-signal] task-progress delivery failed', {
        agentId: event.agentId,
        chatTaskId: event.chatTaskId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
  void sub.psubscribe('sse:*').catch((err) => {
    console.warn('[concierge-signal] bridge subscribe failed', err);
  });
}
