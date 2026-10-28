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
 *
 * Multi-replica (S2): every replica psubscribes and would queue the same signal N times, so
 * each event is first claimed on redis (atomic SET NX EX, one-shot consumer). The claim uses
 * a SEPARATE connection from the subscriber (a subscriber connection cannot issue commands).
 *
 * Testability (S1): heavy imports (`@tourbillon/db`, `@/lib/chat`, thread-store) are lazy —
 * they are only loaded on the real wiring paths — and every side-effecting collaborator is
 * injectable via `startTaskProgressSignalBridge(options)` / `buildTaskProgressBridgeDeps` /
 * `createDeliver`, so the bridge and the deliver policy are unit-testable with fakes.
 */
import IORedis from 'ioredis';
import { aguiSessionScope } from '@/lib/agui/run-input';
import type { Agent } from '@tourbillon/db';
import type { QueueSignalSession, TaskProgressSignalPayload } from '@tourbillon/mastra/concierge-signal';
import {
  handleTaskProgressEvent,
  parseTaskProgressMessage,
  queueTaskProgressSignal,
  taskProgressClaimKey,
  type TaskProgressAgentRecord,
  type TaskProgressBridgeDeps,
} from './task-progress-signals';

/** A seen-transition claim outlives any plausible SSE redelivery window (pub/sub has none). */
export const TASK_PROGRESS_CLAIM_TTL_SECONDS = 900;

// ─── agent + company lookup (S4: inactive tenants are skipped by the pure core) ───────────

async function getAgent(agentId: string): Promise<TaskProgressAgentRecord | null> {
  // Lazy: keeps this module importable (and its pure wiring testable) without db/env.
  const { db, agents, companies } = await import('@tourbillon/db');
  const { eq } = await import('drizzle-orm');
  const row = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!row) return null;
  const company = await db.query.companies.findFirst({ where: eq(companies.id, row.companyId) });
  if (!company) return null; // no tenant row — nothing to deliver into
  return {
    id: row.id,
    companyId: row.companyId,
    status: row.status,
    companyStatus: company.status,
  };
}

// ─── deliver policy (session lookup / idle retarget / busy skip) ───────────────────────────

/** The Session slice deliver() uses (structurally duck-typed, like the pure helpers). */
export interface DeliverSession extends QueueSignalSession {
  thread: { getId(): string | null; switch(opts: { threadId: string }): unknown };
  getCurrentRunId(): string | null | undefined;
}

export interface DeliverChatController {
  /** Real Mastra sessions return undefined (not null) when nothing matches. */
  getSessionByResource(resourceId: string, scope: string): Promise<DeliverSession | null | undefined>;
}

export interface DeliverDeps {
  resourceId(agent: TaskProgressAgentRecord): Promise<string> | string;
  getOrCreateChatController(agent: TaskProgressAgentRecord): Promise<DeliverChatController>;
  getChatSession(
    controller: DeliverChatController,
    agent: TaskProgressAgentRecord,
    opts: { resourceId: string; scope: string; threadId: string },
  ): Promise<DeliverSession>;
}

/**
 * Build the deliver policy over injected chat plumbing (S1: testable with a fake controller).
 *
 * Queue one payload on the agent's free-chat AG-UI session (the one the dashboard uses:
 * resourceId = company free-chat, scope = agui:<agentId>). An idle session on another thread
 * is moved onto the pinned thread first (same rule as Clear-chat retargeting); a session busy
 * on another thread is left alone — hijacking a live run's thread is not what progress is for.
 */
export function createDeliver(deps: DeliverDeps) {
  return async function deliver(
    agent: TaskProgressAgentRecord,
    threadId: string,
    payload: TaskProgressSignalPayload,
  ): Promise<boolean> {
    const resourceId = await deps.resourceId(agent);
    const scope = aguiSessionScope(agent);
    const controller = await deps.getOrCreateChatController(agent);
    let session = await controller.getSessionByResource(resourceId, scope);
    if (!session) {
      session = await deps.getChatSession(controller, agent, { resourceId, scope, threadId });
    } else if (session.thread.getId() !== threadId) {
      if (session.getCurrentRunId()) return false;
      await session.thread.switch({ threadId });
    }
    await queueTaskProgressSignal(session, payload);
    return true;
  };
}

const realDeliver = createDeliver({
  resourceId: async (agent) => (await import('@/lib/chat')).chatResourceId(agent.companyId),
  getOrCreateChatController: async (agent) =>
    (await import('@/lib/chat')).getOrCreateChatController(agent as unknown as Agent),
  getChatSession: async (controller, agent, opts) =>
    (await import('@/lib/chat')).getChatSession(controller as never, agent as unknown as Agent, opts),
});

// ─── redis single-consumer claim (S2) ──────────────────────────────────────────────────────

export interface ClaimClient {
  /** true = first claimer (deliver); false = already claimed by another replica (skip). */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
}

function redisClaimClient(): ClaimClient {
  // Separate from the subscriber connection: a pub/sub connection cannot issue commands.
  const client = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  return {
    async claim(key, ttlSeconds) {
      try {
        return (await client.set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
      } catch (err) {
        // Fail OPEN: a duplicate signal is cheaper than a dropped notification.
        console.warn('[concierge-signal] claim failed; delivering anyway (at-least-once)', {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
        return true;
      }
    },
  };
}

// ─── deps assembly + subscriber loop ───────────────────────────────────────────────────────

export interface TaskProgressBridgeWiring {
  getAgent?: (agentId: string) => Promise<TaskProgressAgentRecord | null>;
  getActiveThreadId?: (scope: { companyId: string; agentId: string }) => Promise<string | null>;
  deliver?: (agent: TaskProgressAgentRecord, threadId: string, payload: TaskProgressSignalPayload) => Promise<boolean>;
  claimClient?: ClaimClient;
  log?: { warn: (msg: string, data?: Record<string, unknown>) => void };
}

/** Assemble the pure-core deps from (overridable) real collaborators. */
export function buildTaskProgressBridgeDeps(wiring: TaskProgressBridgeWiring = {}): TaskProgressBridgeDeps<TaskProgressAgentRecord> {
  const claimClient = wiring.claimClient ?? redisClaimClient();
  return {
    getAgent: wiring.getAgent ?? getAgent,
    getActiveThreadId:
      wiring.getActiveThreadId ??
      ((scope) => import('@/lib/assistant/thread-store').then((m) => m.getActiveAssistantThreadId(scope))),
    deliver: wiring.deliver ?? realDeliver,
    claimEvent: (event) => claimClient.claim(taskProgressClaimKey(event), TASK_PROGRESS_CLAIM_TTL_SECONDS),
    log: wiring.log ?? { warn: (msg, data) => console.warn(msg, data ?? '') },
  };
}

/** The Subscriber slice the bridge uses (an IORedis satisfies it structurally). */
export interface BridgeSubscriber {
  on(event: 'pmessage', listener: (pattern: string, channel: string, message: string) => void): unknown;
  psubscribe(pattern: string): Promise<unknown>;
}

export interface StartBridgeOptions extends TaskProgressBridgeWiring {
  createSubscriber?: () => BridgeSubscriber;
}

const globalForBridge = globalThis as unknown as {
  tourbillonTaskProgressBridge?: { started: boolean };
};

function defaultSubscriber(): BridgeSubscriber {
  return new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
}

/** Start the redis → queueSignal bridge (idempotent per process). `options` are test seams. */
export function startTaskProgressSignalBridge(options: StartBridgeOptions = {}): void {
  if (globalForBridge.tourbillonTaskProgressBridge) return;
  globalForBridge.tourbillonTaskProgressBridge = { started: true };

  const sub = (options.createSubscriber ?? defaultSubscriber)();
  const deps = buildTaskProgressBridgeDeps(options);
  sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
    if (!channel.startsWith('sse:')) return;
    const event = parseTaskProgressMessage(message);
    if (!event) return;
    void handleTaskProgressEvent(deps, event).catch((err) => {
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

/** Test hook: let startTaskProgressSignalBridge run again in-process (mirrors the guard). */
export function __resetTaskProgressSignalBridgeForTests(): void {
  delete globalForBridge.tourbillonTaskProgressBridge;
}
