/**
 * Task-notification acceptance harness (TN-*).
 *
 * NOT RUN by the author. Hermes/Spark1 executes this later against ephemeral
 * Redis + Postgres. This module does not migrate, does not skip, and does not
 * substitute FakeSession / a stubbed queueSignal / InMemoryStore.
 *
 * Boundary actually driven:
 *   pollTaskRunner settle (createDefaultTaskRunnerDeps, real finishChatTaskRun +
 *   readTaskState + default emitProgress = createTaskProgressPublisher)
 *   → Redis pub/sub (sse:{companyId})
 *   → startTaskProgressSignalBridge psubscribe → parseTaskProgressMessage
 *   → handleTaskProgressEvent → real claim (SET NX)
 *   → createDeliver → queueTaskProgressSignal → queueConciergeSignal
 *   → Session.queueSignal on a real AgentController from createStubAgentController
 *   → production PostgresStore (getChatThreadStorageForTests)
 *   → a different PostgresStore instance lists the thread
 *
 * Plumbing that is NOT a product edit (required to keep the model deterministic):
 *   `realDeliver` is not exported. It always loads production getOrCreateChatController,
 *   and createChatController hard-codes a live model plus getChatThreadStorage().
 *   There is no storage/model inject on that controller. The bridge's exported
 *   start options accept `deliver`. This harness passes the exported `createDeliver`
 *   (the same function that builds realDeliver) and the exported
 *   `realDeliverGetOrCreateChatController`, with getOrCreateChatController returning
 *   the stub's real AgentController. queueSignal is the real Session method.
 *   A pass-through wrapper records entry then calls the original; it is not a fake.
 *
 *   `getChatSession` from the chat registry also mints a live chat API key
 *   (TOURBILLON_AGENT_TOKEN_SECRET). Session create uses controller.createSession
 *   with the real `chatSessionId` (same id formula as getChatSession).
 *
 *   task-runner is loaded with a runtime import() so apps/web tsc does not pull
 *   wake-runner.ts. That file value-imports redisPub (connects at load) and the
 *   Mastra barrel. The export-shape check below rejects a module that is missing
 *   pollTaskRunner / createDefaultTaskRunnerDeps / createTaskProgressPublisher.
 *   emitProgress is left at the default publisher. startWake is the only injected
 *   dep, and it does not publish: it returns a WakeResult, or calls the real
 *   updateMyTask tool for an ask park. The runner's own settle writes failure parks.
 *
 * Origin thread: chat_tasks.source_thread_id is audit-only. buildTaskRunWake,
 * the Redis payload, parseTaskProgressMessage, and handleTaskProgressEvent do not
 * carry it. Delivery uses getActiveAssistantThreadId (the pin). These tests do
 * not weaken TN-ORIGIN-SWITCH* to "follow the pin".
 *
 * route.ts waitForSessionRunIdle is not imported. It is the AG-UI user follow-up
 * wait (OUT_OF_PATH for this boundary).
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import { eq, sql } from 'drizzle-orm';
import {
  addChatTask,
  agents,
  companies,
  db,
  getChatTask,
} from '@tourbillon/db';
import { describeDatabaseTarget, requireDatabaseUrl } from '../../../../packages/db/src/database-url';
import { aguiSessionScope } from '../agui/run-input';
import { chatSessionId } from '../chat/session-id';
import {
  createStubAgentController,
  stubText,
  type StubAgentController,
} from '../agui/testing/stub-agent-controller';
import {
  createDeliver,
  realDeliverGetOrCreateChatController,
  startTaskProgressSignalBridge,
  __resetTaskProgressSignalBridgeForTests,
  type DeliverSession,
} from './task-progress-bridge';
import { parseTaskProgressMessage } from './task-progress-signals';
import { getActiveAssistantThreadId, setActiveAssistantThread } from './thread-store';

export const TN_BOUNDARY_TEST_FILE = 'lib/assistant/task-notification-boundary.test.ts';

/** Bounded window after queueSignal is entered, while chunkGate still holds the open run. */
const EARLY_WINDOW_MS = 1000;
const NOTICE_TIMEOUT_MS = 15000;
/** After a second Redis copy, how long a second queueSignal/persist may still appear. */
const DEDUPE_QUIET_MS = 3000;
const SERVICE_TIMEOUT_MS = 5000;

const SETUP_MARK = 'TN-SETUP-HOLD';
const ASK_MARKER = 'need-vendor-choice';
const FAIL_MARKER = 'budget-exhausted-marker';

export type TerminalMode = 'done' | 'failure' | 'ask';

export interface NotificationSpec {
  mode: TerminalMode;
  busy: boolean;
  /** Pin a different thread than source_thread_id. */
  switchPin: boolean;
  /** Hold the open run on a thread that is not the pin (real createDeliver drop). */
  busyDetached: boolean;
  republishTerminal: boolean;
  /** Claim-then-fail-deliver probe. Does not assert lost vs recovered vs double. */
  nondeliveryProbe: boolean;
  extraThread: boolean;
  extraAgent: boolean;
  extraCompany: boolean;
}

export interface StoredMessage {
  role: string;
  text: string;
  createdAtMs: number | null;
}

export interface NotificationEvidence {
  taskId: string;
  runId: string;
  title: string;
  expectedStage: 'done' | 'failed' | 'waiting_on_user';
  originThreadId: string;
  pinThreadId: string;
  extraThreadId: string | null;
  otherAgentThreadId: string | null;
  otherCompanyThreadId: string | null;
  pinAtPublish: string | null;
  sourceThreadId: string | null;
  storedStatus: string | null;
  storedNotes: string | null;
  publishedStages: string[];
  originMessages: StoredMessage[];
  pinMessages: StoredMessage[];
  extraThreadMessages: StoredMessage[];
  otherAgentMessages: StoredMessage[];
  otherCompanyMessages: StoredMessage[];
  /** Independent PostgresStore, not the writer singleton. */
  earlyTerminalNotices: StoredMessage[] | null;
  /** Model entries for the terminal stage observed while chunkGate still held. */
  earlyTerminalModelEntries: number | null;
  terminalQueueEntries: number;
  terminalModelEntries: number;
  listMyTasksExecutions: number;
  userSendsAfterEvent: number;
  writerOriginNoticeCount: number;
  scriptError: string | null;
  probe: NondeliveryObservation | null;
  adapter: 'ephemeral-redis+postgres';
  schema: 'current-schema-bootstrap';
  diagnostic: string;
}

export interface NondeliveryObservation {
  classification: 'lost' | 'recovered' | 'double';
  firstAttemptReachedQueueSignal: boolean;
  terminalNotices: number;
  terminalQueueEntries: number;
  redisTerminalCopies: number;
}

export interface FalseRestartEvidence {
  message: string;
  status: string | null;
  publishedStages: string[];
  listMyTasksExecutions: number;
}

export interface TeardownEvidence {
  baselinePatterns: number;
  patternsAfterReset: number;
  stopExport: boolean;
}

interface TaskRunnerApi {
  pollTaskRunner: (
    deps: unknown,
    opts?: { maxConcurrentRuns?: number },
  ) => Promise<{ started: Array<{ taskId: string; runId: string; done: Promise<void> }> }>;
  createDefaultTaskRunnerDeps: (options?: {
    startWake?: (job: { chatTaskId?: string; runId?: string }) => Promise<{
      runId: string;
      status: 'succeeded' | 'failed' | 'skipped';
      errorText?: string;
    }>;
  }) => unknown;
  createTaskProgressPublisher: () => (event: {
    companyId: string;
    agentId: string;
    chatTaskId: string;
    runId: string;
    stage: string;
    status: string;
    detail?: string;
    title: string;
  }) => void;
}

interface LiveSession extends DeliverSession {
  sendMessage: (input: { content: string }) => Promise<unknown>;
  run?: { isRunning: () => boolean };
  thread: DeliverSession['thread'] & {
    create: (input: { id: string; title?: string }) => Promise<unknown>;
    listMessages?: (input: { threadId: string }) => Promise<unknown>;
  };
}

interface StoreLike {
  init?: () => Promise<void>;
  getStore: (domain: 'memory') => Promise<{ listMessages?: (args: { threadId: string; perPage?: number }) => Promise<unknown> }> | { listMessages?: (args: { threadId: string; perPage?: number }) => Promise<unknown> } | undefined;
  close?: () => Promise<void>;
  constructor: { name: string };
}

let chain: Promise<unknown> = Promise.resolve();
let baselinePatterns = 0;
let bridgeStarted = false;
let admin: IORedis | null = null;
let writerStore: StoreLike | null = null;
let readerStore: StoreLike | null = null;
const controllers = new Map<string, StubAgentController>();

/** Run scenario bodies one at a time, in registration order. */
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

let buildChatResourceId: (
  companyId: string,
  context?: { contextType?: string; contextId?: string },
) => string;
let createHeartbeatRuntimeContext: (values: Record<string, unknown>) => unknown;
let updateMyTask: (input: unknown, ctx: unknown) => Promise<{ ok?: boolean; message?: string; error?: string }>;

async function ensureSeams(): Promise<void> {
  if (!buildChatResourceId) buildChatResourceId = await loadBuildChatResourceId();
  if (!createHeartbeatRuntimeContext) createHeartbeatRuntimeContext = await loadHeartbeatContext();
  if (!updateMyTask) updateMyTask = await loadUpdateMyTask();
}

function chatResource(companyId: string): string {
  if (!buildChatResourceId) throw new Error('TN plumbing: chat resource seam was not loaded');
  return buildChatResourceId(companyId, { contextType: 'free' });
}

function firstCountRow(result: unknown): { n?: unknown } | undefined {
  const rows = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)
      ? (result as { rows: unknown[] }).rows
      : null;
  const row = rows?.[0];
  if (!row || typeof row !== 'object') return undefined;
  return row as { n?: unknown };
}

function closedPort(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.port === '1';
  } catch {
    return false;
  }
}

function asTaskRunner(value: unknown): TaskRunnerApi {
  if (!value || typeof value !== 'object') {
    throw new Error('TN plumbing: task-runner module did not load');
  }
  const mod = value as Partial<TaskRunnerApi>;
  if (
    typeof mod.pollTaskRunner !== 'function' ||
    typeof mod.createDefaultTaskRunnerDeps !== 'function' ||
    typeof mod.createTaskProgressPublisher !== 'function'
  ) {
    throw new Error(
      'TN plumbing: task-runner is missing pollTaskRunner, createDefaultTaskRunnerDeps, or createTaskProgressPublisher',
    );
  }
  const source = Function.prototype.toString.call(mod.createTaskProgressPublisher);
  if (!source.includes('redis-pub')) {
    throw new Error('TN plumbing: createTaskProgressPublisher is not the Redis publisher');
  }
  return mod as TaskRunnerApi;
}

async function loadTaskRunner(): Promise<TaskRunnerApi> {
  // Runtime import of the real module. A static specifier would make apps/web tsc
  // compile wake-runner.ts (redisPub connects on import; Mastra barrel).
  const href = new URL('../../../../packages/scheduler/src/task-runner.ts', import.meta.url).href;
  const importer = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
  return asTaskRunner(await importer(href));
}

const harnessDir = dirname(fileURLToPath(import.meta.url));

/** Runtime import so apps/web tsc does not compile the Mastra chat/tool graph from this file. */
const importRuntime = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>;

async function loadBuildChatResourceId(): Promise<
  (companyId: string, context?: { contextType?: string; contextId?: string }) => string
> {
  const mod = (await importRuntime('@tourbillon/mastra/chat')) as { buildChatResourceId?: unknown };
  if (typeof mod.buildChatResourceId !== 'function') {
    throw new Error('TN plumbing: @tourbillon/mastra/chat is missing buildChatResourceId');
  }
  return mod.buildChatResourceId as (
    companyId: string,
    context?: { contextType?: string; contextId?: string },
  ) => string;
}

async function loadHeartbeatContext(): Promise<(values: Record<string, unknown>) => unknown> {
  const mod = (await importRuntime('@tourbillon/mastra/tools-api-client')) as {
    createHeartbeatRuntimeContext?: unknown;
  };
  if (typeof mod.createHeartbeatRuntimeContext !== 'function') {
    throw new Error('TN plumbing: tools-api-client is missing createHeartbeatRuntimeContext');
  }
  return mod.createHeartbeatRuntimeContext as (values: Record<string, unknown>) => unknown;
}

async function loadUpdateMyTask(): Promise<(input: unknown, ctx: unknown) => Promise<{ ok?: boolean; message?: string }>> {
  const href = new URL('../../../../packages/mastra/src/tools/chat-task-tools.ts', import.meta.url).href;
  const mod = (await importRuntime(href)) as { updateMyTaskTool?: { execute?: unknown } };
  const execute = mod.updateMyTaskTool?.execute;
  if (typeof execute !== 'function') {
    throw new Error('TN plumbing: updateMyTaskTool.execute is missing');
  }
  return execute as (input: unknown, ctx: unknown) => Promise<{ ok?: boolean; message?: string }>;
}

async function loadChatThreadStorage(): Promise<StoreLike> {
  const href = new URL('../../../../packages/mastra/src/chat-controller.ts', import.meta.url).href;
  const mod = (await importRuntime(href)) as { getChatThreadStorageForTests?: unknown };
  if (typeof mod.getChatThreadStorageForTests !== 'function') {
    throw new Error('TN plumbing: getChatThreadStorageForTests is not exported');
  }
  const store = (mod.getChatThreadStorageForTests as () => StoreLike)();
  if (!store || store.constructor?.name === 'InMemoryStore') {
    throw new Error('ADAPTER LIMITATION: getChatThreadStorageForTests returned InMemoryStore');
  }
  return store;
}

function loadPostgresStore(): new (args: { id: string; connectionString: string }) => StoreLike {
  const mastraRequire = createRequire(join(harnessDir, '../../../../packages/mastra/package.json'));
  const mod = mastraRequire('@mastra/pg') as { PostgresStore?: new (args: { id: string; connectionString: string }) => StoreLike };
  if (typeof mod.PostgresStore !== 'function') {
    throw new Error('TN plumbing: @mastra/pg PostgresStore export is missing');
  }
  return mod.PostgresStore;
}

async function openStore(id: string): Promise<StoreLike> {
  const Store = loadPostgresStore();
  const store = new Store({ id, connectionString: requireDatabaseUrl('tn PostgresStore') });
  if (store.constructor.name === 'InMemoryStore') {
    throw new Error('ADAPTER LIMITATION: refusing InMemoryStore');
  }
  if (typeof store.init === 'function') await store.init();
  return store;
}

async function listStored(store: StoreLike, threadId: string): Promise<StoredMessage[]> {
  const memory = await store.getStore('memory');
  if (!memory || typeof memory.listMessages !== 'function') {
    const keys = memory && typeof memory === 'object' ? Object.keys(memory).join(', ') : 'none';
    throw new Error(
      `TN plumbing: PostgresStore memory.listMessages is missing (have: ${keys}). ` +
        'Assertions need a fresh list of this thread; no writer-cache substitute is used.',
    );
  }
  const listed = await memory.listMessages({ threadId, perPage: 500 });
  if (listed && typeof listed === 'object' && 'hasMore' in listed && (listed as { hasMore?: unknown }).hasMore === true) {
    throw new Error(`TN plumbing: listMessages truncated thread ${threadId}`);
  }
  return normalizeMessages(listed);
}

function normalizeMessages(listed: unknown): StoredMessage[] {
  const rows = Array.isArray(listed)
    ? listed
    : listed && typeof listed === 'object' && Array.isArray((listed as { messages?: unknown }).messages)
      ? ((listed as { messages: unknown[] }).messages)
      : null;
  if (!rows) {
    throw new Error('TN plumbing: listMessages returned neither an array nor { messages }');
  }
  return rows.map((row) => {
    const rec = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
    const created = rec.createdAt instanceof Date
      ? rec.createdAt.getTime()
      : typeof rec.createdAt === 'string' || typeof rec.createdAt === 'number'
        ? new Date(rec.createdAt).getTime()
        : null;
    return {
      role: typeof rec.role === 'string' ? rec.role : '',
      text: collectText(rec.content) || collectText(row),
      createdAtMs: created !== null && Number.isFinite(created) ? created : null,
    };
  });
}

function collectText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(collectText).join('\n');
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).map(collectText).join('\n');
  }
  return '';
}

function notices(messages: StoredMessage[], taskId: string, stage: string): StoredMessage[] {
  const marker = `TN-NOTICE task=${taskId} run=`;
  return messages.filter((message) => message.text.includes(marker) && message.text.includes(`stage=${stage}`));
}

function startedMessages(messages: StoredMessage[], taskId: string): StoredMessage[] {
  return messages.filter((message) => message.text.includes(`TN-STARTED task=${taskId} `));
}

async function numpat(): Promise<number> {
  if (!admin) throw new Error('TN plumbing: redis admin connection is not open');
  const count = await admin.call('PUBSUB', 'NUMPAT');
  const value = Number(count);
  if (!Number.isFinite(value)) throw new Error('TN plumbing: PUBSUB NUMPAT was not a number');
  return value;
}

async function waitFor(label: string, pred: () => Promise<boolean> | boolean, timeoutMs: number, detail: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() >= deadline) throw new Error(`TN timeout: ${label}; ${detail()}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

export async function assertBoundaryPrerequisites(): Promise<void> {
  await ensureSeams();
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl) {
    throw new Error('TN prerequisite failed: DATABASE_URL is required (disposable database). Not skipped.');
  }
  if (!redisUrl) {
    throw new Error('TN prerequisite failed: REDIS_URL is required. Not skipped.');
  }
  if (closedPort(databaseUrl) || closedPort(redisUrl)) {
    throw new Error(
      'TN prerequisite failed: DATABASE_URL/REDIS_URL point at a closed port. ' +
        'The publisher swallows Redis errors and the claim fails open, so this suite refuses that env. Not skipped.',
    );
  }
  requireDatabaseUrl('tn boundary');
  admin = new IORedis(redisUrl, { maxRetriesPerRequest: 1, connectTimeout: SERVICE_TIMEOUT_MS });
  const pong = await admin.ping();
  if (pong !== 'PONG') throw new Error('TN prerequisite failed: Redis PING did not return PONG');
  const tables = ['companies', 'agents', 'chat_tasks', 'assistant_active_threads', 'heartbeat_runs', 'activity_log'];
  for (const table of tables) {
    try {
      await db.execute(sql.raw(`select 1 from ${table} limit 0`));
    } catch (err) {
      throw new Error(
        `TN prerequisite failed: current-schema bootstrap is missing table ${table} ` +
          `(${err instanceof Error ? err.message : String(err)}). ` +
          'Apply the existing drizzle journal to the disposable database. This suite does not migrate. Not skipped.',
      );
    }
  }
  const countRows = await db.execute(sql`select count(*)::int as n from chat_tasks`);
  const first = firstCountRow(countRows);
  if (!first || !('n' in first)) {
    throw new Error(
      'TN plumbing: could not read chat_tasks count from the disposable database. Not skipped.',
    );
  }
  if (Number(first.n) !== 0) {
    throw new Error(
      'TN prerequisite failed: chat_tasks is not empty. Refusing to poll a shared database. ' +
        'Use a disposable database bootstrapped from the current schema. Not skipped.',
    );
  }
  writerStore = await loadChatThreadStorage();
  if (typeof writerStore.init === 'function') await writerStore.init();
  readerStore = await openStore('tn-independent-reader');
  if (readerStore === writerStore) {
    throw new Error('TN plumbing: independent PostgresStore is the writer singleton');
  }
}

async function ensureBridge(): Promise<void> {
  if (bridgeStarted) return;
  const before = await numpat();
  const deliver = createDeliver({
    resourceId: (agent) => chatResource(agent.companyId),
    getOrCreateChatController: (agent) =>
      realDeliverGetOrCreateChatController(agent, async () => ({
        getOrCreateChatController: async () => {
          const stub = controllers.get(agent.id);
          if (!stub) {
            throw new Error(
              `TN plumbing: no stub AgentController registered for ${agent.id}. ` +
                'Refusing to fall through to the live-model chat controller.',
            );
          }
          return stub.controller as { getSession(sessionId: string): Promise<DeliverSession | null | undefined> };
        },
      })),
    getChatSession: async (_controller, agent, opts) => {
      const stub = controllers.get(agent.id);
      if (!stub) throw new Error(`TN plumbing: no stub session factory for ${agent.id}`);
      const created: unknown = await stub.controller.createSession({
        resourceId: opts.resourceId,
        id: chatSessionId(opts.resourceId, opts.scope),
        ownerId: stub.controller.id,
        threadId: opts.threadId,
      });
      return asLiveSession(created);
    },
  });
  startTaskProgressSignalBridge({ deliver });
  await waitFor(
    'redis psubscribe readiness',
    async () => (await numpat()) > before,
    SERVICE_TIMEOUT_MS,
    () => 'startTaskProgressSignalBridge did not psubscribe sse:*',
  );
  baselinePatterns = before;
  bridgeStarted = true;
}

function asLiveSession(value: unknown): LiveSession {
  if (!value || typeof value !== 'object') throw new Error('TN plumbing: session missing');
  const session = value as LiveSession;
  if (typeof session.queueSignal !== 'function' || typeof session.sendMessage !== 'function') {
    throw new Error('TN plumbing: real session.queueSignal/sendMessage missing');
  }
  if (!session.thread || typeof session.thread.create !== 'function' || typeof session.thread.switch !== 'function') {
    throw new Error('TN plumbing: real session.thread.create/switch missing');
  }
  return session;
}

function extractAttrLast(blob: string, key: string): string | null {
  const patterns = [
    new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'g'),
    new RegExp(`${key}="([^"]+)"`, 'g'),
    new RegExp(`${key}\\\\"\\s*:\\s*\\\\"([^\\\\"]+)`, 'g'),
    new RegExp(`${key}=\\\\"([^\\\\"]+)\\\\"`, 'g'),
  ];
  let last: string | null = null;
  for (const pattern of patterns) {
    for (const match of blob.matchAll(pattern)) {
      if (match[1]) last = match[1];
    }
  }
  return last;
}

function stageOf(mode: TerminalMode): 'done' | 'failed' | 'waiting_on_user' {
  if (mode === 'done') return 'done';
  if (mode === 'failure') return 'failed';
  return 'waiting_on_user';
}

interface Arm {
  stub: StubAgentController;
  session: LiveSession;
  listMyTasksExecutions: () => number;
  terminalQueueEntries: () => number;
  terminalModelEntries: () => number;
  scriptError: () => string | null;
  waitForTerminalEntry: () => Promise<void>;
  userSends: () => number;
}

async function armController(input: {
  companyId: string;
  agentId: string;
  taskId: string;
  title: string;
  mode: TerminalMode;
  originThreadId: string;
  activeThreadId: string;
  extraThreadId: string | null;
  busy: boolean;
  /** Persist whatever task identity arrives so a mis-route is visible. */
  bystander?: boolean;
}): Promise<Arm & { releaseBusy: (() => void) | null }> {
  const expectedStage = stageOf(input.mode);
  let listMyTasksExecutions = 0;
  let terminalQueueEntries = 0;
  let terminalModelEntries = 0;
  let userSends = 0;
  let scriptError: string | null = null;
  let resolveTerminal: (() => void) | null = null;
  const terminalEntered = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  let releaseBusy: (() => void) | null = null;
  const hold = input.busy
    ? new Promise<void>((resolve) => {
        releaseBusy = resolve;
      })
    : null;
  let heldOnce = false;

  const stub = await createStubAgentController({
    storage: writerStore,
    tools: {
      listMyTasks: () => {
        listMyTasksExecutions += 1;
        return { tasks: [] };
      },
    },
    chunkGate: input.busy
      ? async ({ call, chunk }) => {
          if (call !== 1 || heldOnce || chunk.type !== 'text-delta') return;
          heldOnce = true;
          if (hold) await hold;
        }
      : undefined,
    script: (_call, prompt) => {
      try {
        const blob = JSON.stringify(prompt);
        const taskId = extractAttrLast(blob, 'taskId');
        const runId = extractAttrLast(blob, 'runId');
        const stage = extractAttrLast(blob, 'stage');
        const sawSignal = Boolean(taskId || stage || blob.includes('task-progress') || blob.includes('Background task'));
        if (!sawSignal && blob.includes(SETUP_MARK)) {
          return stubText('setup', ['TN-SETUP-ACK']);
        }
        if (!taskId || !runId || !stage) {
          throw new Error(
            `TN model oracle: prompt missing task identity (taskId=${taskId ?? 'missing'} runId=${runId ?? 'missing'} stage=${stage ?? 'missing'}). ` +
              `excerpt=${blob.slice(0, 600)}`,
          );
        }
        if (input.bystander) {
          return stubText('bystander', [`TN-BYSTANDER task=${taskId} run=${runId} stage=${stage}`]);
        }
        if (taskId !== input.taskId) {
          throw new Error(`TN model oracle: task identity ${taskId} !== ${input.taskId}`);
        }
        if (!blob.includes(input.title)) {
          throw new Error(`TN model oracle: title ${input.title} missing from prompt`);
        }
        if (stage === 'started') {
          return stubText('started', [`TN-STARTED task=${taskId} run=${runId} stage=started`]);
        }
        if (stage !== expectedStage) {
          throw new Error(`TN model oracle: stage ${stage} !== expected ${expectedStage}`);
        }
        if (expectedStage === 'failed') {
          if (!blob.includes(FAIL_MARKER)) throw new Error('TN model oracle: failure detail missing from prompt');
          if (blob.includes('waiting on the human')) {
            throw new Error('TN model oracle: failure context is dressed as an ask');
          }
        }
        if (expectedStage === 'waiting_on_user' && !blob.includes(ASK_MARKER)) {
          throw new Error('TN model oracle: ask detail missing from prompt');
        }
        terminalModelEntries += 1;
        const detail = expectedStage === 'failed' ? FAIL_MARKER : expectedStage === 'waiting_on_user' ? ASK_MARKER : '';
        return stubText('notice', [`TN-NOTICE task=${taskId} run=${runId} stage=${stage} detail=${detail}`]);
      } catch (err) {
        scriptError = err instanceof Error ? err.message : String(err);
        throw err;
      }
    },
  });

  controllers.set(input.agentId, stub);
  const resourceId = chatResource(input.companyId);
  const scope = aguiSessionScope({ id: input.agentId });
  const created = asLiveSession(await stub.createSession(resourceId, scope));
  const found = asLiveSession(await stub.controller.getSession(chatSessionId(resourceId, scope)));
  if (found !== created && (await stub.controller.getSession(chatSessionId(resourceId, scope))) == null) {
    throw new Error('TN plumbing: session id does not match chatSessionId');
  }
  const session = found;
  await session.thread.create({ id: input.originThreadId, title: input.originThreadId });
  if (input.activeThreadId !== input.originThreadId) {
    await session.thread.create({ id: input.activeThreadId, title: input.activeThreadId });
  }
  if (input.extraThreadId) await session.thread.create({ id: input.extraThreadId, title: input.extraThreadId });
  await session.thread.switch({ threadId: input.activeThreadId });
  if (session.thread.getId() !== input.activeThreadId) {
    throw new Error(`TN plumbing: session thread is ${session.thread.getId()}, wanted ${input.activeThreadId}`);
  }
  const original = session.queueSignal.bind(session);
  session.queueSignal = (signal, opts) => {
    const taskId = typeof signal.attributes?.taskId === 'string' ? signal.attributes.taskId : '';
    const stage = typeof signal.attributes?.stage === 'string' ? signal.attributes.stage : '';
    if (taskId === input.taskId && stage === expectedStage) {
      terminalQueueEntries += 1;
      resolveTerminal?.();
    }
    return original(signal, opts);
  };

  if (input.busy) {
    userSends += 1;
    void session.sendMessage({ content: SETUP_MARK }).catch((err) => {
      scriptError = scriptError ?? (err instanceof Error ? err.message : String(err));
    });
    await waitFor(
      'chunkGate hold',
      () => heldOnce && Boolean(session.getCurrentRunId?.() || session.run?.isRunning?.()),
      NOTICE_TIMEOUT_MS,
      () => `busy run did not stay open (${scriptError ?? 'no script error'})`,
    );
  }

  return {
    stub,
    session,
    releaseBusy,
    listMyTasksExecutions: () => listMyTasksExecutions,
    terminalQueueEntries: () => terminalQueueEntries,
    terminalModelEntries: () => terminalModelEntries,
    scriptError: () => scriptError,
    waitForTerminalEntry: () => terminalEntered,
    userSends: () => userSends,
  };
}

/** Second session on an existing stub. createStubAgentController hard-codes controller id `stub-controller`. */
async function armBystander(input: {
  stub: StubAgentController;
  companyId: string;
  agentId: string;
  threadId: string;
}): Promise<void> {
  controllers.set(input.agentId, input.stub);
  const resourceId = chatResource(input.companyId);
  const scope = aguiSessionScope({ id: input.agentId });
  const session = asLiveSession(await input.stub.createSession(resourceId, scope));
  await session.thread.create({ id: input.threadId, title: input.threadId });
  await session.thread.switch({ threadId: input.threadId });
  await setActiveAssistantThread({ companyId: input.companyId, agentId: input.agentId }, input.threadId);
}

async function seedCompany(input: { id: string; agentId: string; failure: boolean }): Promise<void> {
  await db.insert(companies).values({
    id: input.id,
    name: input.id,
    slug: input.id,
    issuePrefix: 'TN',
    settings: input.failure ? { taskRunner: { enabled: true, maxAttemptsPerTask: 1 } } : {},
  });
  await db.insert(agents).values({
    id: input.agentId,
    companyId: input.id,
    name: 'TN Assistant',
    role: 'cto',
    title: 'Assistant',
    urlKey: input.agentId,
    status: 'active',
  });
}

export async function runNotification(spec: NotificationSpec): Promise<NotificationEvidence> {
  await ensureSeams();
  await ensureBridge();
  const runner = await loadTaskRunner();
  const companyId = `tn-${randomUUID()}`;
  const agentId = `tn-agent-${randomUUID()}`;
  const originThreadId = `tn-origin-${randomUUID()}`;
  const pinThreadId = spec.switchPin ? `tn-pin-${randomUUID()}` : originThreadId;
  const extraThreadId = spec.extraThread ? `tn-extra-${randomUUID()}` : null;
  const detachedThreadId = spec.busyDetached ? `tn-detached-${randomUUID()}` : null;
  const title = `tn-title-${randomUUID()}`;
  const expectedStage = stageOf(spec.mode);
  const activeThreadId = spec.busyDetached ? detachedThreadId! : pinThreadId;
  let otherAgentId: string | null = null;
  let otherAgentThreadId: string | null = null;
  let otherCompanyId: string | null = null;
  let otherCompanyAgentId: string | null = null;
  let otherCompanyThreadId: string | null = null;
  const published: string[] = [];
  const side = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1, connectTimeout: SERVICE_TIMEOUT_MS });
  const sendsAtEvent = { current: 0 };
  let arm: Awaited<ReturnType<typeof armController>> | null = null;
  let taskId = '';
  let runId = '';
  let probe: NondeliveryObservation | null = null;

  try {
    await seedCompany({ id: companyId, agentId, failure: spec.mode === 'failure' });
    const task = await addChatTask(
      { companyId, agentId },
      { title, sourceThreadId: originThreadId },
    );
    taskId = task.id;
    arm = await armController({
      companyId,
      agentId,
      taskId,
      title,
      mode: spec.mode,
      originThreadId,
      activeThreadId,
      extraThreadId: extraThreadId ?? detachedThreadId,
      busy: spec.busy || spec.busyDetached || spec.nondeliveryProbe,
    });
    await setActiveAssistantThread({ companyId, agentId }, pinThreadId);
    if (!arm) throw new Error('TN harness: controller was not armed');
    const pinAtPublish = await getActiveAssistantThreadId({ companyId, agentId });
    if (spec.extraAgent) {
      otherAgentId = `tn-agent-${randomUUID()}`;
      otherAgentThreadId = `tn-other-agent-${randomUUID()}`;
      await db.insert(agents).values({
        id: otherAgentId,
        companyId,
        name: 'TN Other',
        role: 'pm',
        title: 'Other',
        urlKey: otherAgentId,
        status: 'active',
      });
      await armBystander({
        stub: arm.stub,
        companyId,
        agentId: otherAgentId,
        threadId: otherAgentThreadId,
      });
    }
    if (spec.extraCompany) {
      otherCompanyId = `tn-${randomUUID()}`;
      otherCompanyAgentId = `tn-agent-${randomUUID()}`;
      otherCompanyThreadId = `tn-other-co-${randomUUID()}`;
      await seedCompany({ id: otherCompanyId, agentId: otherCompanyAgentId, failure: false });
      await armBystander({
        stub: arm.stub,
        companyId: otherCompanyId,
        agentId: otherCompanyAgentId,
        threadId: otherCompanyThreadId,
      });
    }

    side.on('message', (_channel: string, message: string) => {
      const event = parseTaskProgressMessage(message);
      if (!event || event.chatTaskId !== taskId) return;
      published.push(event.stage);
      if (event.stage === expectedStage) lastTerminalRaw.set(taskId, message);
    });
    await side.subscribe(`sse:${companyId}`);
    sendsAtEvent.current = arm.userSends();

    const deps = runner.createDefaultTaskRunnerDeps({
      startWake: async (job) => {
        if (job.chatTaskId !== taskId) {
          throw new Error(`TN harness: poller claimed unexpected task ${job.chatTaskId ?? 'unknown'}`);
        }
        if (spec.mode === 'ask') {
          const requestContext = createHeartbeatRuntimeContext({
            apiKey: 'tn-boundary',
            runId: job.runId ?? 'tn',
            agentId,
            companyId,
            jobId: `tn-${taskId}`,
            threadId: originThreadId,
          });
          const parked = await updateMyTask(
            { id: taskId, status: 'waiting_on_user', ask: ASK_MARKER },
            { requestContext },
          );
          if (!parked.ok) {
            throw new Error(`TN harness: updateMyTask ask park failed: ${parked.error ?? parked.message ?? 'unknown'}`);
          }
        }
        if (spec.mode === 'failure') {
          return { runId: job.runId ?? '', status: 'failed', errorText: FAIL_MARKER };
        }
        return { runId: job.runId ?? '', status: 'succeeded' };
      },
    });
    const summary = await runner.pollTaskRunner(deps, { maxConcurrentRuns: 2 });
    const started = summary.started.filter((row) => row.taskId === taskId);
    if (started.length !== 1) {
      throw new Error(`TN harness: expected one claimed run for ${taskId}, got ${summary.started.length}`);
    }
    await started[0]!.done;
    runId = started[0]!.runId;

    const detail = () =>
      JSON.stringify({
        published,
        scriptError: arm?.scriptError() ?? null,
        queueEntries: arm?.terminalQueueEntries() ?? 0,
        modelEntries: arm?.terminalModelEntries() ?? 0,
        target: describeDatabaseTarget(),
      });

    await waitFor(
      'terminal event on Redis',
      () => published.includes(expectedStage),
      NOTICE_TIMEOUT_MS,
      detail,
    );

    let earlyTerminalNotices: StoredMessage[] | null = null;
    let earlyTerminalModelEntries: number | null = null;
    if (spec.nondeliveryProbe) {
      if (!arm.session.getCurrentRunId?.() && !arm.session.run?.isRunning?.()) {
        throw new Error('TN harness: nondelivery probe required a live run on the detached thread');
      }
      const queueAtFirst = arm.terminalQueueEntries();
      const claimKey = `concierge-signal:seen:${companyId}:${taskId}:${runId}:${expectedStage}`;
      await waitFor(
        'claim key after terminal publish',
        async () => (await admin!.get(claimKey)) !== null || arm!.terminalQueueEntries() > queueAtFirst,
        NOTICE_TIMEOUT_MS,
        detail,
      );
      const deadline = Date.now() + EARLY_WINDOW_MS;
      while (Date.now() < deadline && arm.terminalQueueEntries() === queueAtFirst) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      const firstReached = arm.terminalQueueEntries() > queueAtFirst;
      if (firstReached) {
        throw new Error(
          'TN harness: nondelivery probe reached queueSignal on the first attempt, so claim-before-failed-deliver was not armed. ' +
            'createDeliver did not drop the busy detached session. No lost/recovered/double classification is recorded.',
        );
      }
      arm.releaseBusy?.();
      await waitFor(
        'detached run idle',
        () => !arm!.session.run?.isRunning?.() && !arm!.session.getCurrentRunId?.(),
        NOTICE_TIMEOUT_MS,
        detail,
      );
      await arm.session.thread.switch({ threadId: pinThreadId });
      const terminalRaw = await captureTerminal(side, companyId, taskId, expectedStage, published);
      runner.createTaskProgressPublisher()(terminalRaw);
      await waitFor(
        'republished terminal on Redis',
        () => published.filter((stage) => stage === expectedStage).length >= 2,
        NOTICE_TIMEOUT_MS,
        detail,
      );
      const observeUntil = Date.now() + NOTICE_TIMEOUT_MS;
      while (Date.now() < observeUntil) {
        const seen = notices(await listStored(readerStore!, originThreadId), taskId, expectedStage).length;
        if (seen >= 2) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      const terminalNotices = notices(await listStored(readerStore!, originThreadId), taskId, expectedStage);
      const classification = terminalNotices.length === 0 ? 'lost' : terminalNotices.length === 1 ? 'recovered' : 'double';
      probe = {
        classification,
        firstAttemptReachedQueueSignal: firstReached,
        terminalNotices: terminalNotices.length,
        terminalQueueEntries: arm.terminalQueueEntries(),
        redisTerminalCopies: published.filter((stage) => stage === expectedStage).length,
      };
    } else {
      if (spec.busy || spec.busyDetached) {
        await arm.waitForTerminalEntry();
        const deadline = Date.now() + EARLY_WINDOW_MS;
        const sampleEarly = async () => {
          const onOrigin = notices(await listStored(readerStore!, originThreadId), taskId, expectedStage);
          if (pinThreadId === originThreadId) return onOrigin;
          const onPin = notices(await listStored(readerStore!, pinThreadId), taskId, expectedStage);
          return [...onOrigin, ...onPin];
        };
        let early = await sampleEarly();
        while (Date.now() < deadline && early.length === 0 && arm.terminalModelEntries() === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          early = await sampleEarly();
        }
        earlyTerminalNotices = early;
        earlyTerminalModelEntries = arm.terminalModelEntries();
        arm.releaseBusy?.();
      }
      await waitFor(
        'one terminal notice on the independent Postgres reader',
        async () => notices(await listStored(readerStore!, spec.switchPin ? originThreadId : activeThreadId), taskId, expectedStage).length >= 1
          || notices(await listStored(readerStore!, originThreadId), taskId, expectedStage).length >= 1
          || (pinThreadId !== originThreadId && notices(await listStored(readerStore!, pinThreadId), taskId, expectedStage).length >= 1),
        NOTICE_TIMEOUT_MS,
        detail,
      );
      if (spec.republishTerminal) {
        const terminalRaw = await captureTerminal(side, companyId, taskId, expectedStage, published);
        runner.createTaskProgressPublisher()(terminalRaw);
        await waitFor(
          'duplicate terminal on Redis',
          () => published.filter((stage) => stage === expectedStage).length >= 2,
          NOTICE_TIMEOUT_MS,
          detail,
        );
        const quietUntil = Date.now() + DEDUPE_QUIET_MS;
        while (Date.now() < quietUntil) {
          if (arm.terminalQueueEntries() > 1 || notices(await listStored(readerStore!, originThreadId), taskId, expectedStage).length > 1) {
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
      }
    }

    const stored = await getChatTask({ companyId, agentId }, { id: taskId });
    const originMessages = await listStored(readerStore!, originThreadId);
    const pinMessages = pinThreadId === originThreadId ? originMessages : await listStored(readerStore!, pinThreadId);
    const extraThreadMessages = extraThreadId ? await listStored(readerStore!, extraThreadId) : [];
    const otherAgentMessages = otherAgentThreadId ? await listStored(readerStore!, otherAgentThreadId) : [];
    const otherCompanyMessages = otherCompanyThreadId ? await listStored(readerStore!, otherCompanyThreadId) : [];
    let writerOriginNoticeCount = -1;
    if (typeof arm.session.thread.listMessages === 'function') {
      writerOriginNoticeCount = notices(
        normalizeMessages(await arm.session.thread.listMessages({ threadId: originThreadId })),
        taskId,
        expectedStage,
      ).length;
    }
    const evidence: NotificationEvidence = {
      taskId,
      runId,
      title,
      expectedStage,
      originThreadId,
      pinThreadId,
      extraThreadId,
      otherAgentThreadId,
      otherCompanyThreadId,
      pinAtPublish,
      sourceThreadId: stored?.sourceThreadId ?? null,
      storedStatus: stored?.status ?? null,
      storedNotes: stored?.notes ?? null,
      publishedStages: published,
      originMessages,
      pinMessages,
      extraThreadMessages,
      otherAgentMessages,
      otherCompanyMessages,
      earlyTerminalNotices,
      earlyTerminalModelEntries,
      terminalQueueEntries: arm.terminalQueueEntries(),
      terminalModelEntries: arm.terminalModelEntries(),
      listMyTasksExecutions: arm.listMyTasksExecutions(),
      userSendsAfterEvent: arm.userSends() - sendsAtEvent.current,
      writerOriginNoticeCount,
      scriptError: arm.scriptError(),
      probe,
      adapter: 'ephemeral-redis+postgres',
      schema: 'current-schema-bootstrap',
      diagnostic: '',
    };
    evidence.diagnostic = diagnostic(evidence);
    return evidence;
  } finally {
    side.disconnect();
    arm?.releaseBusy?.();
    controllers.delete(agentId);
    if (otherAgentId) controllers.delete(otherAgentId);
    if (otherCompanyAgentId) controllers.delete(otherCompanyAgentId);
    lastTerminalRaw.delete(taskId);
    await db.delete(companies).where(eq(companies.id, companyId));
    if (otherCompanyId) await db.delete(companies).where(eq(companies.id, otherCompanyId));
  }
}

function diagnostic(evidence: NotificationEvidence): string {
  return JSON.stringify({
    taskId: evidence.taskId,
    runId: evidence.runId,
    expectedStage: evidence.expectedStage,
    originThreadId: evidence.originThreadId,
    pinThreadId: evidence.pinThreadId,
    pinAtPublish: evidence.pinAtPublish,
    sourceThreadId: evidence.sourceThreadId,
    storedStatus: evidence.storedStatus,
    publishedStages: evidence.publishedStages,
    originNotices: notices(evidence.originMessages, evidence.taskId, evidence.expectedStage).length,
    pinNotices: notices(evidence.pinMessages, evidence.taskId, evidence.expectedStage).length,
    queueEntries: evidence.terminalQueueEntries,
    modelEntries: evidence.terminalModelEntries,
    writerOriginNoticeCount: evidence.writerOriginNoticeCount,
    scriptError: evidence.scriptError,
    adapter: evidence.adapter,
    schema: evidence.schema,
    target: describeDatabaseTarget(),
  });
}

async function captureTerminal(
  _side: IORedis,
  companyId: string,
  taskId: string,
  stage: string,
  published: string[],
): Promise<{
  companyId: string;
  agentId: string;
  chatTaskId: string;
  runId: string;
  stage: string;
  status: string;
  detail?: string;
  title: string;
}> {
  const raw = lastTerminalRaw.get(taskId);
  const event = raw ? parseTaskProgressMessage(raw) : null;
  if (!event || event.stage !== stage || event.companyId !== companyId) {
    throw new Error(
      `TN harness: no captured Redis payload for ${taskId} stage ${stage} (saw ${published.join(',') || 'none'})`,
    );
  }
  return event;
}

const lastTerminalRaw = new Map<string, string>();

export async function runFalseRestart(): Promise<FalseRestartEvidence> {
  await ensureSeams();
  await ensureBridge();
  const companyId = `tn-${randomUUID()}`;
  const agentId = `tn-agent-${randomUUID()}`;
  const published: string[] = [];
  const side = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1, connectTimeout: SERVICE_TIMEOUT_MS });
  try {
    await seedCompany({ id: companyId, agentId, failure: false });
    const task = await addChatTask({ companyId, agentId }, { title: `tn-false-${randomUUID()}`, sourceThreadId: `tn-origin-${randomUUID()}` });
    const requestContext = createHeartbeatRuntimeContext({
      apiKey: 'tn-boundary',
      runId: 'tn-false-run',
      agentId,
      companyId,
      jobId: 'tn-false-run',
      threadId: task.sourceThreadId ?? undefined,
    });
    side.on('message', (_channel: string, message: string) => {
      const event = parseTaskProgressMessage(message);
      if (event?.chatTaskId === task.id) published.push(event.stage);
    });
    await side.subscribe(`sse:${companyId}`);
    const parked = await updateMyTask(
      { id: task.id, status: 'waiting_on_user', ask: ASK_MARKER },
      { requestContext },
    );
    if (!parked.ok) throw new Error(`TN harness: could not park for false-run: ${parked.message ?? 'unknown'}`);
    const flipped = await updateMyTask(
      { id: task.id, status: 'in_progress' },
      { requestContext },
    );
    const stored = await getChatTask({ companyId, agentId }, { id: task.id });
    await new Promise<void>((resolve) => setImmediate(resolve));
    return {
      message: flipped.message ?? '',
      status: stored?.status ?? null,
      publishedStages: published,
      listMyTasksExecutions: 0,
    };
  } finally {
    side.disconnect();
    await db.delete(companies).where(eq(companies.id, companyId));
  }
}

export async function runTeardown(): Promise<TeardownEvidence> {
  await ensureBridge();
  const bridge = (await import('./task-progress-bridge')) as Record<string, unknown>;
  const stopExport = typeof bridge.stopTaskProgressSignalBridge === 'function';
  __resetTaskProgressSignalBridgeForTests();
  bridgeStarted = false;
  return {
    baselinePatterns,
    patternsAfterReset: await numpat(),
    stopExport,
  };
}

export async function readWithNewPostgresStore(threadId: string): Promise<StoredMessage[]> {
  const store = await openStore(`tn-fresh-${randomUUID()}`);
  try {
    return await listStored(store, threadId);
  } finally {
    await store.close?.();
  }
}

export function terminalNotices(evidence: NotificationEvidence, messages: StoredMessage[] = evidence.originMessages): StoredMessage[] {
  return notices(messages, evidence.taskId, evidence.expectedStage);
}

export function startedNotices(evidence: NotificationEvidence, messages: StoredMessage[] = evidence.originMessages): StoredMessage[] {
  return startedMessages(messages, evidence.taskId);
}

export function closeBoundaryResources(): void {
  admin?.disconnect();
  admin = null;
  void readerStore?.close?.();
  readerStore = null;
}
