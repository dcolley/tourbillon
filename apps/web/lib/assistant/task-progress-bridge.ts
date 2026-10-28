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

/** The `@tourbillon/db` slice getAgent reads (softs S10: injectable fake in tests). */
export interface TaskProgressDbQuery {
  agents: { findFirst(args: unknown): Promise<{ id: string; companyId: string; status: string } | undefined> };
  companies: { findFirst(args: unknown): Promise<{ status: string } | undefined> };
}

/** The `drizzle-orm` slice getAgent uses — only `eq` — kept structural for the same reason. */
export interface TaskProgressOrm {
  eq(column: unknown, value: unknown): unknown;
}

/**
 * The `@tourbillon/db` table-object slice getAgent passes to `eq` (softs S13). Injectable so
 * tests hand in DISTINCT sentinels per table — then the fake `eq` can pin WHICH column each
 * lookup constrains on. Without this the injected path used `{}` for both tables, so e.g.
 * `eq(agents.id, row.companyId)` for the company join stayed invisible.
 */
export interface TaskProgressDbTables {
  agents: { id: unknown };
  companies: { id: unknown };
}

/**
 * The lazy `@tourbillon/db` module slice getAgent consumes on the DEFAULT path (softs S15):
 * the drizzle instance behind `db.query.*` plus the table objects handed to `eq`. Injectable
 * so a test can assert the DEFAULT path actually queries the module's `db` EXPORT — the B1
 * regression (passing the module namespace itself, which has no `query`) fails against an
 * object identity the fake module controls, without a live Postgres.
 */
export interface TaskProgressDbModule {
  db: { query: TaskProgressDbQuery };
  agents: TaskProgressDbTables['agents'];
  companies: TaskProgressDbTables['companies'];
}

/** A seen-transition claim outlives any plausible SSE redelivery window (pub/sub has none). */
export const TASK_PROGRESS_CLAIM_TTL_SECONDS = 900;

// ─── agent + company lookup (S4: inactive tenants are skipped by the pure core) ───────────

/**
 * Default lazy loader for the `@tourbillon/db` module (softs S15). Kept as a named export so
 * it can be swapped — and so the seam `loadDb` below is the ONLY place the module namespace
 * is touched.
 */
export async function loadRealDbModule(): Promise<TaskProgressDbModule> {
  return (await import('@tourbillon/db')) as unknown as TaskProgressDbModule;
}

/**
 * Agent row + its tenant row joined into the bridge's record slice. `orm` / `db` / `tables`
 * are injectable (softs S10, S13) so the REAL company join, `companyStatus` mapping and the
 * columns behind each `eq` are exercised against fakes — the lazy `import()` stays the default
 * production path. `tables` is only consulted on the injected-`db` path (production supplies
 * the real drizzle table objects from the same module import). `loadDb` replaces the lazy
 * import on the default path (softs S15) so a test can pin that the module's `db` EXPORT —
 * not the module namespace (B1) — is what receives the queries.
 */
export async function getAgent(
  agentId: string,
  sources: {
    db?: { query: TaskProgressDbQuery };
    orm?: TaskProgressOrm;
    tables?: TaskProgressDbTables;
    loadDb?: () => Promise<TaskProgressDbModule>;
  } = {},
): Promise<TaskProgressAgentRecord | null> {
  // Lazy: keeps this module importable (and its pure wiring testable) without db/env.
  const real = sources.db ? undefined : await (sources.loadDb ?? loadRealDbModule)();
  // B1: the module NAMESPACE has no `query` export — the default path must use the module's
  // `db` export (and its `agents`/`companies` table exports below).
  const db = (sources.db ?? real?.db) as { query: TaskProgressDbQuery };
  if (sources.db && !sources.tables) {
    // S16: an injected db with no tables would silently fall back to `{}` — the exact blind
    // spot S13 closed (every `eq` would record column:undefined and a swapped join stayed
    // invisible). Fail loudly instead of quietly degrading the assertions.
    throw new Error(
      'getAgent: an injected `sources.db` requires `sources.tables` — without distinct ' +
        'agents/companies table objects the eq() column pinning (S13) is silently lost.',
    );
  }
  const agents = (sources.tables?.agents ?? real?.agents ?? {}) as Record<string, unknown>;
  const companies = (sources.tables?.companies ?? real?.companies ?? {}) as Record<string, unknown>;
  const { eq } = sources.orm ?? ((await import('drizzle-orm')) as unknown as TaskProgressOrm);
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

/** The ioredis slice the claim client drives (softs S11: fake-IORedis in tests). */
export interface RedisClaimCommands {
  set(key: string, value: string, mode: 'EX', ttlSeconds: number, nx: 'NX'): Promise<string | null>;
}

export function redisClaimClient(client: RedisClaimCommands = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  // Separate from the subscriber connection: a pub/sub connection cannot issue commands.
  maxRetriesPerRequest: null,
})): ClaimClient {
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
