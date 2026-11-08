/**
 * CONCIERGE-QUEUE-SIGNAL: real subscriber wiring for the TASK-RUNNER → free-chat bridge.
 *
 * Runs once per web server process (started from instrumentation.ts). Pattern-subscribes the
 * company SSE channels, filters `chat_task_progress` events published by the scheduler's
 * TASK-RUNNER poller, and queues each one as a typed reactive `task-progress` signal on the
 * task's ORIGINATING free-chat thread (TASK-1 `chat_tasks.source_thread_id`, company+agent
 * scoped) — reusing the SAME AgentController the dashboard chat uses. When the origin thread
 * is the live user session's own thread the notice shares that session queue (Mastra
 * ordering: idle → wakes the thread now; active → delivered after the current run). When it
 * is not, delivery runs through an origin-bound distinct session created by the SAME real
 * controller: the active pin is never read or written and no session's thread is switched
 * (TN-ORIGIN / H3, demonstrated feasible on Spark1 2026-11-08).
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
// Leaf module (no deps) — static import so the S332-S2 pin exercises the REAL keying helper.
import { chatSessionId } from '@/lib/chat/session-id';
import type { Agent } from '@tourbillon/db';
import type { QueueSignalSession, TaskProgressSignalPayload } from '@tourbillon/mastra/concierge-signal';
import {
  handleTaskProgressEvent,
  parseTaskProgressMessage,
  queueTaskProgressSignal,
  taskProgressClaimKey,
  type TaskProgressAgentRecord,
  type TaskProgressBridgeDeps,
  type TaskProgressEvent,
  type TaskProgressOriginResolution,
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
 * The `@tourbillon/db` module slice the bridge consumes on the DEFAULT path (softs S15):
 * the drizzle instance behind `db.query.*` plus the table objects handed to `eq`, plus the
 * TN-ORIGIN scoped task lookup (H2). Injectable so a test can pin that the DEFAULT path
 * actually queries the module's `db` EXPORT — the B1 regression (passing the module
 * namespace itself, which has no `query`) fails against an object identity the fake module
 * controls, without a live Postgres.
 */
export interface TaskProgressDbModule {
  db: { query: TaskProgressDbQuery };
  agents: TaskProgressDbTables['agents'];
  companies: TaskProgressDbTables['companies'];
  /**
   * TN-ORIGIN (H2): the scoped chat-task read. MUST be the module's own `getChatTask`
   * (company+agent scoped `chat_tasks` query) — a foreign-scope id never resolves to another
   * tenant's row. Only `sourceThreadId` is consumed here.
   */
  getChatTask(
    scope: { companyId: string; agentId: string },
    input: { id: string },
  ): Promise<{ sourceThreadId: string | null } | null>;
}

/** A seen-transition claim outlives any plausible SSE redelivery window (pub/sub has none). */
export const TASK_PROGRESS_CLAIM_TTL_SECONDS = 900;

// ─── agent + company lookup (S4: inactive tenants are skipped by the pure core) ───────────

/**
 * The slice of the REAL `@tourbillon/db` module exports the bridge reads (softs S17). Used as
 * the annotation for the loaders below so the default path is pinned to the module's actual
 * export types — an `as unknown as TaskProgressDbModule` erasure no longer fits here, because
 * the interface's minimal `db` (`{ query }`) is not assignable to the real drizzle client.
 */
export type RealDbModuleSlice = Pick<
  typeof import('@tourbillon/db'),
  'db' | 'agents' | 'companies' | 'getChatTask'
>;

/**
 * S17 compile pin: build the bridge's db-module slice from the REAL exports. `satisfies`
 * typechecks `db` / `agents` / `companies` against `TaskProgressDbModule` at typecheck time —
 * a shape drift in `@tourbillon/db` (renamed `db` export, dropped `query`, table object
 * missing the `id` column getAgent's `eq` uses) fails `tsc --noEmit` immediately instead of
 * only surfacing through the S15 probe, and unlike `as unknown as` nothing is erased. The
 * B1/S15 runtime guards in getAgent stay exactly as they were.
 */
export function sliceRealDbModule(mod: typeof import('@tourbillon/db')): RealDbModuleSlice {
  return {
    db: mod.db,
    agents: mod.agents,
    companies: mod.companies,
    // TN-ORIGIN (H2): the module's OWN scoped getChatTask — the default origin lookup runs
    // the real company+agent-scoped query, not an ad-hoc reimplementation.
    getChatTask: mod.getChatTask,
  } satisfies TaskProgressDbModule;
}

/**
 * Default lazy loader for the `@tourbillon/db` module (softs S15). Kept as a named export so
 * it can be swapped — and so the seam `loadDb` below is the ONLY place the module namespace
 * is touched. S17: the return type is the REAL export slice (not the interface), routed
 * through `sliceRealDbModule`'s `satisfies` pin; loosening either back to an unconstrained
 * cast turns the type-level pins in task-progress-bridge.test.ts red.
 */
export async function loadRealDbModule(): Promise<RealDbModuleSlice> {
  return sliceRealDbModule(await import('@tourbillon/db'));
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
  // S18 (soft of #209): no call-site cast — `real.db` is the REAL drizzle client type (S17
  // slice), so the annotated assignment below is itself the check that it structurally fits
  // the `{ query: TaskProgressDbQuery }` seam getAgent uses (the same fit S17's `satisfies`
  // pin asserts). If `@tourbillon/db` ever drops `db`/`query`, tsc fails HERE, not at runtime.
  const dbSource = sources.db ?? real?.db;
  if (!dbSource) {
    // Unreachable through startTaskProgressSignalBridge: either `sources.db` was injected or
    // `loadDb` returned a TaskProgressDbModule. Loud guard keeps the narrowing honest without
    // an `as` cast over the union.
    throw new Error('getAgent: no db source — neither `sources.db` nor the loaded module provided one.');
  }
  const db: { query: TaskProgressDbQuery } = dbSource;
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
  // S18: annotated assignment instead of `as unknown as TaskProgressOrm` — the real drizzle
  // `eq` (method-form bivariance on the interface) must structurally fit the seam, so a
  // renamed/incompatible `eq` export is a tsc error, not an erased cast.
  const orm: TaskProgressOrm = sources.orm ?? (await import('drizzle-orm'));
  const { eq } = orm;
  const row = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!row) return null;
  const company = await db.query.companies.findFirst({ where: eq(companies.id, row.companyId) });
  if (!company) return null; // no tenant row — nothing to deliver into
  return {
    id: row.id,
    companyId: row.companyId,
    status: row.status,
    companyStatus: company.status,
    // Pass through the NOT NULL runtime_config column. Stripping it makes the
    // origin-bound H3 session path throw on `runtimeConfig.mail` in skill-loader
    // / agent-factory when a controller is assembled from this record.
    runtimeConfig: row.runtimeConfig ?? {},
  };
}

// ─── TN-ORIGIN: authoritative scoped origin lookup (H2) ──────────────────────────────────

/**
 * Resolve the task's originating thread from the AUTHORITATIVE `chat_tasks.source_thread_id`
 * row, company+agent scoped (the event's own tenant pair — a task id belonging to another
 * company/agent NEVER resolves to a foreign thread, R8; C-SCOPE-LOOKUP kills scope drops).
 *
 * Outcomes (H2 / reconciliation C3):
 *  - missing task            -> { skip: 'task-not-found' }  (recorded skip, claim consumed, no retry promise)
 *  - present, null/empty origin -> { skip: 'missing-origin' } (legacy/malformed row)
 *  - present with origin     -> { threadId }                 (the only routing source — the pin is never consulted)
 *  - DB ERROR                -> PROPAGATES (surfaced as an error, never a silent skip).
 *
 * Lazy like getAgent: the `@tourbillon/db` import happens on the default path only.
 */
export async function getTaskOriginFromDb(
  event: TaskProgressEvent,
  sources: { loadDb?: () => Promise<TaskProgressDbModule> } = {},
): Promise<TaskProgressOriginResolution> {
  const real = await (sources.loadDb ?? loadRealDbModule)();
  const row = await real.getChatTask(
    { companyId: event.companyId, agentId: event.agentId },
    { id: event.chatTaskId },
  );
  if (!row) return { skip: 'task-not-found' };
  if (!row.sourceThreadId) return { skip: 'missing-origin' };
  return { threadId: row.sourceThreadId };
}

// ─── deliver policy (origin-targeted session selection; NO pin mutation) ───────────────────

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
 * Deterministic session-id scope for the ORIGIN-BOUND delivery session of one free-chat
 * agent. The user's live session stays at `chatSessionId(resourceId, scope)` untouched; the
 * notice is queued through a DISTINCT real session `${scope}::origin:${threadId}` created by
 * the SAME controller (H3 feasibility, demonstrated on Spark1 2026-11-08: Mastra 1.81 keys
 * the run queue by (resourceId, threadId), so an idle origin wakes immediately and a busy
 * origin queues behind its OWN run, while an unrelated busy thread is simply a different
 * key — no pin mutation, no thread switching, no drop-because-someone-is-busy).
 */
export function taskProgressOriginScope(scope: string, threadId: string): string {
  return `${scope}::origin:${threadId}`;
}

/**
 * Build the deliver policy over injected chat plumbing (S1: testable with a fake controller).
 *
 * Queue one payload on the ORIGIN thread's free-chat AG-UI session (resourceId = company
 * free-chat, scope = agui:<agentId>):
 *  - the live user session is already bound to the origin thread -> share its queue (the
 *    notice serializes behind the human's own queued work on the ORIGIN thread, Mastra-owned);
 *  - otherwise (user session on another thread, idle or busy, or no session yet) -> deliver
 *    through the origin-bound session created via the SAME real controller.
 *
 * HARD RULES (v2 §1.1/§1.3, §14.3 R1–R3, C4–C6): the active pin is never read or written
 * here; an existing session's thread is NEVER switched; a busy UNRELATED thread is never a
 * reason to drop or delay this notice. Only the origin thread's own busy run serializes it.
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
    const userSession = await controller.getSessionByResource(resourceId, scope);
    if (userSession && userSession.thread.getId() === threadId) {
      // Same-thread fast path: one shared queue with the human's queued follow-ups.
      await queueTaskProgressSignal(userSession, payload);
      return true;
    }
    // Origin-bound distinct session (never touch the user session's thread, idle or busy).
    const originSession = await deps.getChatSession(controller, agent, {
      resourceId,
      scope: taskProgressOriginScope(scope, threadId),
      threadId,
    });
    if (!originSession) return false;
    await queueTaskProgressSignal(originSession, payload);
    return true;
  };
}

/**
 * S19b: the narrow Agent slice the two chat call sites in `realDeliver` actually consume from
 * the bridge record. Stricter than the S18 `as Partial<Agent> as Agent` seam it replaces:
 * `Pick` keeps `id` / `companyId` / `status` REQUIRED, so the first assertion step is only
 * comparable when the record still carries all three with Agent-compatible types — a lost or
 * retyped field breaks tsc at the call site. `Partial<Agent>` made every key optional, so it
 * checked only the keys the record happened to share. Agent fields OUTSIDE the seam stay a
 * deliberate widening: the chat path reads more of Agent (registry.ts), but the bridge only
 * guarantees this slice, and naming it here is what makes the gap visible (the type-level
 * pins in task-progress-bridge.test.ts keep the seam honest).
 */
export type ChatAgentSeam = Pick<Agent, 'id' | 'companyId' | 'status'>;

/** The chat-module slice the deliver adapter consumes (S332-S2 seam shape). */
export type RealDeliverChatModule = {
  getOrCreateChatController(
    agent: Agent,
  ): Promise<{ getSession(sessionId: string): Promise<DeliverSession | null | undefined> }>;
};

/**
 * S332-S2: the (resourceId, scope) -> live-session adapter used by `realDeliver`, extracted
 * and exported so a test can PIN it. Before this, the adapter lived only inside the
 * `realDeliver` closure while the bridge test injected a fake `getSessionByResource` at the
 * `DeliverDeps` seam — so reverting the Mastra 1.81 fix here (`getSession(resourceId)`,
 * scope dropped) kept the whole suite GREEN while the bridge silently delivered to the wrong
 * (or no) session. `task-progress-bridge-332-softs.test.ts` calls THIS function.
 *
 * Test seam (same convention as agent-factory's model-factory option): `loadChat` defaults
 * to the real `@/lib/chat` import; tests inject a fake module. `chatSessionId` stays a
 * STATIC import on purpose — the pin must exercise the real keying helper, not something a
 * mock could replace.
 */
export async function realDeliverGetOrCreateChatController(
  agent: TaskProgressAgentRecord,
  loadChat: () => Promise<RealDeliverChatModule> = () => import('@/lib/chat'),
): Promise<DeliverChatController> {
  const chat = await loadChat();
  const controller = await chat.getOrCreateChatController(agent as ChatAgentSeam as Agent);
  // Mastra 1.81: the live session for (resourceId, scope) is getSession(chatSessionId(...)).
  // Attach the lookup helper to the REAL controller so origin-bound getChatSession
  // can still call createSession (H3). A bare wrapper object is not an AgentController.
  return Object.assign(controller, {
    getSessionByResource: (resourceId: string, scope: string) =>
      controller.getSession(chatSessionId(resourceId, scope)),
  });
}

/**
 * The PRODUCTION deliver policy (default `deliver` dep). Exported so the certification
 * harness can assert the default path actually wires THIS function (no injected deliver).
 */
export const realDeliver = createDeliver({
  resourceId: async (agent) => (await import('@/lib/chat')).chatResourceId(agent.companyId),
  // S18 + S19b: two CHECKED assertion steps through the named `ChatAgentSeam` — never through
  // `unknown`/`any` (the S18/S19a eslint rules in eslint.config.mjs flag those). The first
  // leg is what tsc validates: the record must still structurally fit Pick<Agent, 'id' |
  // 'companyId' | 'status'> — e.g. renaming `companyId` or turning `status` into a boolean
  // breaks tsc HERE. The second leg is the trivial comparable widen ChatAgentSeam -> Agent.
  getOrCreateChatController: realDeliverGetOrCreateChatController,
  getChatSession: async (controller, agent, opts) =>
    (await import('@/lib/chat')).getChatSession(controller as never, agent as ChatAgentSeam as Agent, opts),
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
        // (TN-CLAIM-FAIL-OPEN: this fail-open semantics is UNCHANGED by the lifecycle work.)
        console.warn('[concierge-signal] claim failed; delivering anyway (at-least-once)', {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
        return true;
      }
    },
  };
}

/** A claim client the BRIDGE created and therefore owns (stop closes it). */
export interface OwnedClaimClient extends ClaimClient {
  quit(): Promise<void>;
}

/**
 * Build a bridge-owned claim client on its own connection (a subscriber connection cannot
 * issue commands). The bridge's stop() quits exactly this client — never a caller-injected
 * one (TN-STOP-BORROWED-CLIENTS: injected deps stay caller-owned in every branch).
 */
export function createOwnedRedisClaimClient(
  url: string = process.env.REDIS_URL ?? 'redis://localhost:6379',
): OwnedClaimClient {
  const client = new IORedis(url, { maxRetriesPerRequest: null });
  const claimClient = redisClaimClient(client);
  return {
    claim: (key, ttlSeconds) => claimClient.claim(key, ttlSeconds),
    quit: async () => {
      await client.quit();
    },
  };
}

// ─── deps assembly + subscriber loop ───────────────────────────────────────────────────────

export interface TaskProgressBridgeWiring {
  getAgent?: (agentId: string) => Promise<TaskProgressAgentRecord | null>;
  /**
   * TN-ORIGIN (H2): scoped origin resolution. Default = getTaskOriginFromDb (real scoped
   * getChatTask). The active pin (assistant_active_threads) is NOT part of routing any more.
   */
  getTaskOrigin?: (event: TaskProgressEvent) => Promise<TaskProgressOriginResolution>;
  deliver?: (agent: TaskProgressAgentRecord, threadId: string, payload: TaskProgressSignalPayload) => Promise<boolean>;
  /** Borrowed claim client: the bridge NEVER closes an injected client (C7). */
  claimClient?: ClaimClient;
  log?: { warn: (msg: string, data?: Record<string, unknown>) => void };
}

/**
 * Assemble the pure-core deps from (overridable) real collaborators.
 * NOTE: when no `claimClient` is injected this assembles its OWN claim client (the caller of
 * the standalone assembly is then responsible for its lifetime — the BRIDGE lifecycle path
 * always injects the (owned-or-borrowed) client itself so stop() can close exactly what the
 * bridge created).
 */
export function buildTaskProgressBridgeDeps(wiring: TaskProgressBridgeWiring = {}): TaskProgressBridgeDeps<TaskProgressAgentRecord> {
  const claimClient = wiring.claimClient ?? createOwnedRedisClaimClient();
  return {
    getAgent: wiring.getAgent ?? getAgent,
    getTaskOrigin: wiring.getTaskOrigin ?? ((event) => getTaskOriginFromDb(event)),
    deliver: wiring.deliver ?? realDeliver,
    claimEvent: (event) => claimClient.claim(taskProgressClaimKey(event), TASK_PROGRESS_CLAIM_TTL_SECONDS),
    log: wiring.log ?? { warn: (msg, data) => console.warn(msg, data ?? '') },
  };
}

// ─── lifecycle: owned handle with ACK, bounded drain, idempotent stop (H4) ────────────────

/** The Subscriber slice the bridge uses (an IORedis satisfies it structurally). */
export interface BridgeSubscriber {
  on(event: 'pmessage', listener: (pattern: string, channel: string, message: string) => void): unknown;
  /** Exact-handler removal on stop (TN-TEARDOWN: the retained exact handler must be detached). */
  off?(event: 'pmessage', listener: (pattern: string, channel: string, message: string) => void): unknown;
  /** Resolves on the redis psubscribe ACK — the bridge's ready barrier (B-SUB). */
  psubscribe(pattern: string): Promise<unknown>;
  punsubscribe?(pattern?: string): Promise<unknown>;
  quit?(): Promise<unknown>;
  disconnect?(): unknown;
}

/** Production bound for draining admitted deliveries on stop (H4). Timeouts FAIL (C7). */
export const TASK_PROGRESS_DRAIN_TIMEOUT_MS = 10_000;

export interface TaskProgressBridgeStopReport {
  /** Events admitted by the pmessage handler since start. */
  admitted: number;
  /** Admitted deliveries that settled (success OR logged error). */
  completed: number;
  /** Still-open admitted deliveries when the drain window closed. */
  pending: number;
  drained: boolean;
  timedOut: boolean;
  /** Owned clients closed by this stop (borrowed clients never appear here). */
  closedOwnedClients: string[];
  /** Owned resources that could not be settled — reported, never hidden. */
  unsettled: string[];
  punsubscribed: boolean;
}

/** stop() REJECTS with this on a drain timeout, carrying the full report (C7). */
export class TaskProgressBridgeStopError extends Error {
  readonly name = 'TaskProgressBridgeStopError';
  constructor(
    message: string,
    readonly report: TaskProgressBridgeStopReport,
  ) {
    super(`${message} (admitted=${report.admitted} completed=${report.completed} pending=${report.pending} unsettled=${report.unsettled.join(',') || 'none'})`);
  }
}

export interface TaskProgressBridgeHandle {
  /** Resolves when the bridge-OWNED psubscribe is ACKed (B-SUB). Rejects on subscribe failure. */
  ready: Promise<void>;
  /** Idempotent async stop: repeat calls return the same promise/report (TN-STOP-IDEMPOTENT). */
  stop(): Promise<TaskProgressBridgeStopReport>;
}

export interface StartBridgeOptions extends TaskProgressBridgeWiring {
  createSubscriber?: () => BridgeSubscriber;
  /** Override the bridge-owned claim factory (tests). Ignored when claimClient is injected. */
  createClaimClient?: () => OwnedClaimClient;
  /**
   * Drain bound for stop(). Production default 10 s; ONLY the deterministic timeout cell
   * configures a shorter value — no other cell waits on the bound (C7).
   */
  drainTimeoutMs?: number;
}

interface BridgeInstance {
  handle: TaskProgressBridgeHandle;
  stopPromise?: Promise<TaskProgressBridgeStopReport>;
  stopping: boolean;
  readyPromise?: Promise<void>;
  readyFailure?: unknown;
  subscriber: BridgeSubscriber;
  subscriberOwned: boolean;
  claim: OwnedClaimClient | null;
  claimOwned: boolean;
  handler: (pattern: string, channel: string, message: string) => void;
  admitted: Set<Promise<void>>;
  counters: { admitted: number; completed: number };
  punsubscribed: boolean;
  drainTimeoutMs: number;
}

// S18: intersection cast instead of `globalThis as unknown as {...}` — still one checked
// step (the `typeof globalThis` leg keeps every existing global visible; only the optional
// bridge slot is added).
const globalForBridge = globalThis as typeof globalThis & {
  tourbillonTaskProgressBridge?: BridgeInstance;
};

function defaultSubscriber(): BridgeSubscriber {
  return new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | `__timeout__:${string}`> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<`__timeout__:${string}`>((resolve) => {
    timer = setTimeout(() => resolve(`__timeout__:${label}`), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const isTimeout = (v: unknown): boolean => typeof v === 'string' && v.startsWith('__timeout__:');

/**
 * Start the redis → queueSignal bridge (idempotent per process). Returns the OWNERSHIP
 * handle (TN-SUBSCRIBE-ACK / TN-START-CONCURRENT / TN-STOP-*):
 *  - the singleton slot (and therefore concurrent starts) settles on ONE subscription: the
 *    instance is installed in the global slot BEFORE awaiting the psubscribe ACK, so a
 *    second start never double-subscribes (not merely a flag flipped after the ACK);
 *  - `ready` resolves on the bridge-OWNED psubscribe ACK (B-SUB), rejects on failure after
 *    owned clients are cleaned up, leaving the slot clear for a safe retry;
 *  - stop() detaches the exact pmessage handler, punsubscribes, drains admitted deliveries
 *    under the bounded policy (timeout = FAILURE with counts, never a false-clean pass),
 *    then quits ONLY the clients the bridge created. Borrowed clients are never closed.
 *    Restart never reuses quit clients (fresh factories per start).
 *
 * `options` are test seams. Production callers (instrumentation) use the defaults and may
 * ignore the handle.
 */
export function startTaskProgressSignalBridge(options: StartBridgeOptions = {}): TaskProgressBridgeHandle {
  const existing = globalForBridge.tourbillonTaskProgressBridge;
  if (existing && !existing.stopping) return existing.handle;
  if (existing?.stopping) {
    // Start during stop: await the in-flight stop, then start fresh — never stack a
    // subscription onto a closing instance, never leak a client. The placeholder handle
    // delegates so callers get ONE owned subscription once the fresh start settles.
    const started = existing.stopPromise!.then(() => startTaskProgressSignalBridge(options));
    return {
      ready: started.then((handle) => handle.ready),
      stop: () => started.then((handle) => handle.stop()),
    };
  }

  const subscriber = (options.createSubscriber ?? defaultSubscriber)();
  const subscriberOwned = !options.createSubscriber;
  // Claim ownership: an injected claimClient stays borrowed (never closed by stop); with no
  // injection the bridge CREATES its own owned client and closes it on stop.
  const ownedClaim: OwnedClaimClient | null = options.claimClient
    ? null
    : (options.createClaimClient ?? createOwnedRedisClaimClient)();
  const effectiveWiring: TaskProgressBridgeWiring = ownedClaim
    ? { ...options, claimClient: ownedClaim }
    : options;

  const instance: BridgeInstance = {
    handle: undefined as never,
    stopping: false,
    subscriber,
    subscriberOwned,
    claim: ownedClaim,
    claimOwned: !!ownedClaim,
    handler: undefined as never,
    admitted: new Set(),
    counters: { admitted: 0, completed: 0 },
    punsubscribed: false,
    drainTimeoutMs: options.drainTimeoutMs ?? TASK_PROGRESS_DRAIN_TIMEOUT_MS,
  };

  const deps = buildTaskProgressBridgeDeps(effectiveWiring);

  instance.handler = (pattern: string, channel: string, message: string) => {
    if (instance.stopping) return; // refuse NEW admissions once stop is in flight
    if (!channel.startsWith('sse:')) return;
    const event = parseTaskProgressMessage(message);
    if (!event) return;
    instance.counters.admitted += 1;
    const p: Promise<void> = (async () => {
      try {
        await handleTaskProgressEvent(deps, event);
      } catch (err) {
        // Handler errors SURFACE (warn with full error; C3: an error is never a silent skip)
        // and count as completed for the drain — they must not hold stop hostage.
        console.warn('[concierge-signal] task-progress delivery failed', {
          agentId: event.agentId,
          chatTaskId: event.chatTaskId,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        instance.counters.completed += 1;
      }
    })();
    instance.admitted.add(p);
    void p.finally(() => instance.admitted.delete(p));
  };
  subscriber.on('pmessage', instance.handler);

  // Install the singleton BEFORE awaiting the ACK: concurrent starts resolve to this same
  // handle (exactly ONE owned subscription), and stop-before-ready is representable.
  globalForBridge.tourbillonTaskProgressBridge = instance;

  const readyPromise = subscriber
    .psubscribe('sse:*')
    .then(() => undefined)
    .catch((err: unknown) => {
      // Failed start: release every owned client so a retry starts clean (TN-START-FAIL-RETRY).
      instance.readyFailure = err;
      void closeOwnedClients(instance).finally(() => {
        if (globalForBridge.tourbillonTaskProgressBridge === instance) {
          delete globalForBridge.tourbillonTaskProgressBridge;
        }
      });
      throw err;
    });
  instance.readyPromise = readyPromise;

  const stop = (): Promise<TaskProgressBridgeStopReport> => {
    if (instance.stopPromise) return instance.stopPromise; // idempotent
    instance.stopping = true;
    instance.stopPromise = settleStop(instance);
    return instance.stopPromise;
  };

  instance.handle = { ready: readyPromise, stop };
  return instance.handle;
}

async function settleStop(instance: BridgeInstance): Promise<TaskProgressBridgeStopReport> {
  // 1) Detach the exact pmessage handler and stop admitting.
  try {
    instance.subscriber.off?.('pmessage', instance.handler);
  } catch {
    /* detach failure never masks the drain result; reported via unsettled below if quit fails */
  }
  // 2) Settle the subscription startup deterministically — bounded, even if the ACK never
  //    arrives or failed (TN-STOP-BEFORE-ACK / TN-STOP-ACK-FAILURE: never hang).
  if (instance.readyPromise) {
    await withTimeout(instance.readyPromise.catch(() => undefined), instance.drainTimeoutMs, 'subscription-settle');
  }
  // 3) Punsubscribe (NUMPAT returns to baseline; TN-TEARDOWN).
  try {
    const r = await withTimeout(Promise.resolve(instance.subscriber.punsubscribe?.('sse:*')), instance.drainTimeoutMs, 'punsubscribe');
    instance.punsubscribed = !isTimeout(r);
  } catch {
    instance.punsubscribed = false;
  }
  // 4) Drain admitted deliveries under the bound (H4). A timeout is a FAILURE, not a pass.
  const pendingNow = [...instance.admitted];
  const drainResult = pendingNow.length
    ? await withTimeout(Promise.allSettled(pendingNow).then(() => true), instance.drainTimeoutMs, 'drain')
    : true;
  const drained = drainResult === true;
  // 5) Close owned clients ONLY (borrowed stay open for their caller).
  const closed = await closeOwnedClients(instance);
  if (globalForBridge.tourbillonTaskProgressBridge === instance) {
    delete globalForBridge.tourbillonTaskProgressBridge; // clear the singleton only after shutdown
  }
  const report: TaskProgressBridgeStopReport = {
    admitted: instance.counters.admitted,
    completed: instance.counters.completed,
    pending: instance.admitted.size,
    drained,
    timedOut: !drained,
    closedOwnedClients: closed.closed,
    unsettled: closed.unsettled,
    punsubscribed: instance.punsubscribed,
  };
  if (!drained) {
    throw new TaskProgressBridgeStopError('task-progress bridge stop: admitted deliveries did not settle within the drain bound', report);
  }
  return report;
}

async function closeOwnedClients(
  instance: BridgeInstance,
): Promise<{ closed: string[]; unsettled: string[] }> {
  const closed: string[] = [];
  const unsettled: string[] = [];
  if (instance.subscriberOwned) {
    try {
      const r = await withTimeout(Promise.resolve(instance.subscriber.quit?.()), instance.drainTimeoutMs, 'subscriber-quit');
      if (isTimeout(r)) throw new Error('quit timed out');
      closed.push('subscriber');
    } catch {
      // last-resort force-close so the process can still exit naturally
      try {
        instance.subscriber.disconnect?.();
        closed.push('subscriber:forced-disconnect');
      } catch {
        unsettled.push('subscriber');
      }
    }
  }
  if (instance.claimOwned && instance.claim) {
    try {
      const r = await withTimeout(instance.claim.quit(), instance.drainTimeoutMs, 'claim-quit');
      if (isTimeout(r)) throw new Error('quit timed out');
      closed.push('claim');
    } catch {
      unsettled.push('claim');
    }
  }
  return { closed, unsettled };
}

/**
 * Test hook: fully stops the running bridge (awaits the REAL stop, not a flag flip) so
 * `startTaskProgressSignalBridge` can run again in-process with FRESH clients. A stop
 * failure surfaces but never hangs the caller past the drain bound.
 */
export async function __resetTaskProgressSignalBridgeForTests(): Promise<void> {
  const instance = globalForBridge.tourbillonTaskProgressBridge;
  if (!instance) return;
  try {
    await instance.handle.stop();
  } catch {
    /* stop already reported its failure via the rejection; reset must not mask it further
       nor hang — the slot is cleared below so the next start cannot reuse these clients. */
    if (globalForBridge.tourbillonTaskProgressBridge === instance) {
      delete globalForBridge.tourbillonTaskProgressBridge;
    }
  }
}
