/**
 * TN boundary certification harness — v2.1 (C1–C12).
 *
 * Certification cells drive production defaults: real createTaskProgressPublisher
 * (the poller's emitProgress), real Redis, real startTaskProgressSignalBridge
 * (realDeliver + owned claim/subscriber), real getOrCreateChatController / getChatSession,
 * real Session.queueSignal, real PostgresStore writer, independently constructed reader.
 *
 * The only double is the model, registered per (companyId, agentId) through
 * registerChatModelOverride and removed in finally. No env/endpoint activation.
 *
 * Requires TN_DISPOSABLE=1 and disposable Postgres/Redis. This module does not migrate.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import { agents, chatTasks, companies, db, llmProviders, sql } from '@tourbillon/db';

const harnessDir = dirname(fileURLToPath(import.meta.url));
const mastraRequire = createRequire(join(harnessDir, '../../../../packages/mastra/package.json'));
const { MastraLanguageModelV2Mock, simulateReadableStream } = mastraRequire('@mastra/core/test-utils/llm-mock');
const { PostgresStore } = mastraRequire('@mastra/pg');
const { Pool } = mastraRequire('pg');

export const NOTICE_MARKER = 'TN-NOTICE';
export const USER_MARKER = 'TN-USER-OK';
export const HELD_MARKER = 'TN-HELD-OUTPUT';
export const BYSTANDER_MARKER = 'TN-BYSTANDER-7c1e9d';

export type CapabilityReport = {
  h1Registry: boolean;
  originLookup: boolean;
  bridgeStop: boolean;
  bridgeReady: boolean;
  reason: string[];
};

export const capability: CapabilityReport = {
  h1Registry: false,
  originLookup: false,
  bridgeStop: false,
  bridgeReady: false,
  reason: [],
};

export function isFixedCapable(): boolean {
  return capability.h1Registry && capability.originLookup && capability.bridgeStop && capability.bridgeReady;
}

export const cellVerdicts: Array<{ name: string; verdict: string; detail?: string }> = [];

export function recordVerdict(name: string, verdict: string, detail?: string): void {
  cellVerdicts.push({ name, verdict, detail });
}

type MastraChat = typeof import('@tourbillon/mastra/chat');
type BridgeMod = typeof import('./task-progress-bridge');
type ChatMod = typeof import('@/lib/chat');

let mastraChat: MastraChat | null = null;
let bridgeMod: BridgeMod | null = null;
let chatMod: ChatMod | null = null;
let admin: Redis | null = null;
let protoPatched = false;
const signalLog: Array<{ threadId: string; taskId: string | null; stage: string | null; tagName: string | null; at: string }> = [];
let queueHold: Promise<void> | null = null;

export async function probeCapabilities(): Promise<CapabilityReport> {
  capability.reason = [];
  try {
    mastraChat = await import('@tourbillon/mastra/chat');
    capability.h1Registry = typeof mastraChat.registerChatModelOverride === 'function';
  } catch (err) {
    capability.h1Registry = false;
    capability.reason.push(`mastra/chat import failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!capability.h1Registry) capability.reason.push('registerChatModelOverride missing (H1)');

  try {
    bridgeMod = await import('./task-progress-bridge');
    capability.originLookup = typeof bridgeMod.getTaskOriginFromDb === 'function';
    const src = Function.prototype.toString.call(bridgeMod.startTaskProgressSignalBridge);
    capability.bridgeReady = src.includes('ready') && src.includes('psubscribe');
    capability.bridgeStop = src.includes('stop') && src.includes('drain');
  } catch (err) {
    capability.originLookup = false;
    capability.bridgeStop = false;
    capability.bridgeReady = false;
    capability.reason.push(`bridge import failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!capability.originLookup) capability.reason.push('getTaskOriginFromDb missing (H2)');
  if (!capability.bridgeStop || !capability.bridgeReady) capability.reason.push('bridge ready/stop lifecycle missing (H4)');

  try {
    chatMod = await import('@/lib/chat');
  } catch (err) {
    capability.reason.push(`chat registry import failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return capability;
}

export async function assertBoundaryPrerequisites(): Promise<void> {
  if (process.env.TN_DISPOSABLE !== '1') {
    throw new Error('TN prerequisite failed: TN_DISPOSABLE=1 required (disposable PG/Redis only). Not skipped.');
  }
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const redisUrl = process.env.REDIS_URL ?? '';
  if (!databaseUrl) throw new Error('TN prerequisite failed: DATABASE_URL required. Not skipped.');
  if (!redisUrl) throw new Error('TN prerequisite failed: REDIS_URL required. Not skipped.');
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('TN prerequisite failed: DATABASE_URL is not a URL. Not skipped.');
  }
  if (!['127.0.0.1', 'localhost', 'postgres'].includes(parsed.hostname)) {
    throw new Error('TN prerequisite failed: DATABASE_URL host is not a disposable loopback/service host. Not skipped.');
  }
  if (parsed.port === '1') {
    throw new Error('TN prerequisite failed: DATABASE_URL points at the closed-port CI sentinel. Not skipped.');
  }
  admin = new Redis(redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 8_000 });
  if ((await admin.ping()) !== 'PONG') throw new Error('TN prerequisite failed: Redis PING failed. Not skipped.');
  for (const table of ['companies', 'agents', 'chat_tasks', 'assistant_active_threads', 'llm_providers']) {
    try {
      await db.execute(sql.raw(`select 1 from ${table} limit 0`));
    } catch (err) {
      throw new Error(
        `TN prerequisite failed: missing table ${table} (${err instanceof Error ? err.message : String(err)}). ` +
          'Apply the existing drizzle journal to the disposable database; this suite does not migrate. Not skipped.',
      );
    }
  }
  // Disposable DB only (host already checked): wipe leftover certification rows so a
  // previous interrupted run cannot poison the empty-table guard.
  await db.execute(sql`delete from chat_tasks where id like 'tn-%' or id like 'h3probe-%' or id like 'h1-%'`);
  const rows = (await db.execute(sql`select count(*)::int as n from chat_tasks`)) as unknown;
  const arr = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as Array<{ n: number }>;
  if (!arr[0] || Number(arr[0].n) !== 0) {
    throw new Error('TN prerequisite failed: chat_tasks not empty — disposable database required. Not skipped.');
  }
  await probeCapabilities();
}

export async function tnTeardown(): Promise<void> {
  if (admin) {
    await admin.quit().catch(() => {});
    admin = null;
  }
  await shutdownReader();
  try {
    const registry = await import('@/lib/chat/registry');
    registry.clearChatControllerCache();
  } catch {
    /* ignore */
  }
  try {
    const { getChatThreadStorageForTests } = await import('../../../../packages/mastra/src/chat-controller.ts');
    const store = getChatThreadStorageForTests();
    if (store && typeof (store as { shutdown?: () => Promise<void> }).shutdown === 'function') {
      await (store as { shutdown: () => Promise<void> }).shutdown();
    }
  } catch {
    /* ignore */
  }
  try {
    const pub = await import('../../../../packages/scheduler/src/redis-pub.ts');
    const redis = await import('../../../../packages/scheduler/src/redis.ts');
    // redis-pub eagerly constructs redisPub; redis.ts also eagerly constructs the
    // deprecated `connection` singleton on the same import. Quitting only redisPub
    // leaves that second socket open and prevents a natural node:test exit (H4).
    const clients = [pub.redisPub, redis.connection].filter(Boolean) as Array<{
      quit?: () => Promise<unknown>;
      disconnect?: () => void;
    }>;
    await Promise.all(
      clients.map(async (c) => {
        try {
          await c.quit?.();
        } catch {
          c.disconnect?.();
        }
      }),
    );
  } catch {
    /* publisher may never have been imported */
  }
  try {
    const g = globalThis as unknown as { postgresClient?: { end?: (opts?: { timeout: number }) => Promise<void> } };
    await g.postgresClient?.end?.({ timeout: 2 });
  } catch {
    /* ignore */
  }
}

export function tnSignalRecords(filter?: { taskId?: string; tagName?: string }): typeof signalLog {
  return signalLog.filter(
    (r) => (!filter?.taskId || r.taskId === filter.taskId) && (!filter?.tagName || r.tagName === filter.tagName),
  );
}

export function tnSetQueueHold(gate: Promise<void> | null): void {
  queueHold = gate;
}

function collectPromptText(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map(collectPromptText).join("\n");
  const rec = node as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof rec.text === "string") parts.push(rec.text);
  if (typeof rec.content === "string") parts.push(rec.content);
  else if (rec.content != null) parts.push(collectPromptText(rec.content));
  if (Array.isArray(rec.parts)) parts.push(collectPromptText(rec.parts));
  return parts.join("\n");
}

function lastUserRoleText(prompt: unknown): string | null {
  if (!Array.isArray(prompt)) return null;
  for (let i = prompt.length - 1; i >= 0; i -= 1) {
    const msg = prompt[i] as { role?: string };
    if (msg && msg.role === "user") return collectPromptText(msg);
  }
  return null;
}

function makeModel(holdUser: boolean) {
  let entries = 0;
  let gateOpen = !holdUser;
  let release: (() => void) | null = null;
  let userHolds = 0;
  const callLog: Array<{ identity: string; notice: boolean; at: string }> = [];
  const model = {
    mock: null as unknown,
    callLog,
    entryCount: () => entries,
    releaseChunks() {
      gateOpen = true;
      release?.();
    },
  };
  model.mock = new MastraLanguageModelV2Mock({
    doStream: async (opts: { prompt: unknown }) => {
      const blob = JSON.stringify(opts.prompt ?? {});
      // Classify from the latest user-role content. Agent instructions mention
      // <task-progress>, so a whole-prompt blob match would treat every live
      // user turn (including TN-HOLD-USER) as a notice and never engage the hold.
      const lastUser = lastUserRoleText(opts.prompt);
      const notice = lastUser != null
        ? lastUser.includes('<task-progress')
        : !blob.includes('TN-HOLD-USER') && blob.includes('<task-progress');
      const holdThis = holdUser && !notice && (lastUser ?? blob).includes('TN-HOLD-USER') && userHolds === 0;
      if (holdThis) userHolds += 1;
      const taskId = /"taskId"\s*:\s*"([^"]+)"/.exec(blob)?.[1] ?? 'unknown-task';
      const stage = /"stage"\s*:\s*"([^"]+)"/.exec(blob)?.[1] ?? 'done';
      callLog.push({ identity: notice ? 'notice' : 'user', notice, at: new Date().toISOString() });
      entries += 1;
      if (holdThis) {
        while (!gateOpen) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      }
      const text = notice
        ? `${NOTICE_MARKER} ${taskId} ${stage} <task-progress>`
        : holdThis
          ? HELD_MARKER
          : blob.includes('TN-BYSTANDER')
            ? BYSTANDER_MARKER
            : USER_MARKER;
      const id = 'tn-stream';
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id },
            { type: 'text-delta', id, delta: text },
            { type: 'text-end', id },
            { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          ],
          chunkDelayInMs: 0,
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
  return model;
}

let readerStore: { getStore: (n: 'memory') => Promise<{ listMessages: (a: unknown) => Promise<unknown> } | null>; shutdown?: () => Promise<void> } | null = null;

async function openReader() {
  if (readerStore) return readerStore;
  const store = new PostgresStore({ id: 'tn-reader-shared', connectionString: process.env.DATABASE_URL });
  if (store.constructor?.name !== 'PostgresStore') throw new Error('ADAPTER LIMITATION (C-PERSIST): non-Postgres store');
  await store.init?.();
  readerStore = store;
  return store;
}

export async function tnFreshMessages(threadId: string): Promise<string[]> {
  const store = await openReader();
  const memory = await store.getStore('memory');
  if (!memory || typeof memory.listMessages !== 'function') {
    throw new Error('TN plumbing: independent reader lacks memory.listMessages');
  }
  const listed = await memory.listMessages({ threadId, perPage: 500 });
  const bag = listed as { messages?: unknown[]; records?: unknown[] } | unknown[];
  const rows = Array.isArray(bag)
    ? bag
    : Array.isArray((bag as { messages?: unknown[] }).messages)
      ? (bag as { messages: unknown[] }).messages
      : Array.isArray((bag as { records?: unknown[] }).records)
        ? (bag as { records: unknown[] }).records
        : [];
  const blob = JSON.stringify(listed);
  if (rows.length === 0 && blob.includes(NOTICE_MARKER)) {
    // Fall back: the store nested the payload in a shape we do not enumerate.
    return [blob];
  }
  return rows.map((row) => JSON.stringify(row));
}

export async function tnFreshText(threadId: string): Promise<string> {
  return (await tnFreshMessages(threadId)).join('\n');
}

export async function shutdownReader(): Promise<void> {
  if (readerStore && typeof readerStore.shutdown === 'function') {
    await readerStore.shutdown().catch(() => {});
  }
  readerStore = null;
}

export function countNotices(text: string, taskId: string, stage?: string): number {
  const parts = text.includes('\n{') ? text.split('\n').filter((line) => line.startsWith('{') || line.includes(NOTICE_MARKER)) : [text];
  // The delivered notice IS the persisted signal row (role 'signal'). Model echoes of the
  // same text (a woken agent restating the tag) must not inflate the oracle — count signals.
  return parts.filter(
    (m) =>
      m.includes('"role":"signal"') &&
      m.includes(NOTICE_MARKER) &&
      m.includes(taskId) &&
      (!stage || m.includes(stage)),
  ).length;
}

export function countNoticeMessages(messages: string[], taskId: string, stage?: string): number {
  return messages.filter((m) => {
    const isProgress = m.includes('task-progress') || m.includes(NOTICE_MARKER);
    const hasTask = m.includes(`"taskId":"${taskId}"`) || m.includes(taskId);
    const hasStage = !stage || m.includes(`"stage":"${stage}"`) || m.includes(` ${stage} `);
    return isProgress && hasTask && hasStage;
  }).length;
}

export function tnTrace(step: string, extra?: Record<string, unknown>): void {
  const payload = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : "";
  console.log(`[TN-TRACE] ${new Date().toISOString()} ${step}${payload}`);
}



export async function waitFor(label: string, pred: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  tnTrace(`waitFor:start ${label}`, { timeoutMs });
  const start = Date.now();
  let polls = 0;
  for (;;) {
    const elapsed = Date.now() - start;
    const remaining = timeoutMs - elapsed;
    if (remaining <= 0) {
      tnTrace(`waitFor:timeout ${label}`, { elapsed, polls });
      throw new Error(`TN timeout: ${label}`);
    }
    const predStarted = Date.now();
    let ok = false;
    try {
      ok = await Promise.race([
        pred(),
        new Promise<boolean>((_, reject) => {
          const t = setTimeout(() => reject(new Error(`TN timeout: ${label} (predicate hung)`)), remaining);
          t.unref?.();
        }),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tnTrace(`waitFor:pred-error ${label}`, { err: msg, elapsed: Date.now() - start, polls });
      throw err;
    }
    const predMs = Date.now() - predStarted;
    polls += 1;
    if (ok || predMs > 400 || polls <= 3 || polls % 25 === 0) {
      tnTrace(`waitFor:poll ${label}`, { ok, predMs, elapsed: Date.now() - start, polls });
    }
    if (ok) {
      tnTrace(`waitFor:done ${label}`, { elapsed: Date.now() - start, polls });
      return;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
}

type Publisher = (event: Record<string, unknown>) => void;
let publisher: Publisher | null = null;

export async function loadPublisher(): Promise<Publisher> {
  if (publisher) return publisher;
  const href = new URL('../../../../packages/scheduler/src/task-runner.ts', import.meta.url).href;
  const importer = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<Record<string, unknown>>;
  const mod = await importer(href);
  if (typeof mod.createTaskProgressPublisher !== 'function' || typeof mod.createDefaultTaskRunnerDeps !== 'function') {
    throw new Error('TN plumbing: task-runner missing createTaskProgressPublisher / createDefaultTaskRunnerDeps');
  }
  const src = Function.prototype.toString.call(mod.createTaskProgressPublisher);
  if (!src.includes('redis-pub') && !src.includes('redisPub')) {
    throw new Error('TN plumbing: createTaskProgressPublisher is not the Redis publisher');
  }
  const deps = (mod.createDefaultTaskRunnerDeps as (o?: Record<string, unknown>) => { emitProgress?: Publisher })({
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
  if (typeof deps.emitProgress !== 'function') {
    throw new Error('TN plumbing: default task-runner deps did not provide emitProgress');
  }
  publisher = deps.emitProgress;
  return publisher;
}

export async function publishProgress(event: Record<string, unknown>): Promise<void> {
  tnTrace('publishProgress:start', { chatTaskId: event.chatTaskId, stage: event.stage });
  const emit = await loadPublisher();
  emit(event);
  tnTrace('publishProgress:emitted');
}

export interface TnFixture {
  companyId: string;
  agentId: string;
  companyIdB: string;
  agentIdB: string;
  providerId: string;
  t1: string;
  t2: string;
  t3: string;
  t9: string;
  t1b: string;
  bystanderCompanyId: string;
  bystanderAgentId: string;
  taskId: string;
  taskId2: string;
  taskIdB: string;
  models: { a: ReturnType<typeof makeModel>; b: ReturnType<typeof makeModel>; bystander: ReturnType<typeof makeModel> };
  pinBefore: string | null;
  controllerA: { id: string };
  controllerB: { id: string };
  recordA: unknown;
  recordB: unknown;
  userSession: { thread: { getId(): string | null; switch(opts: { threadId: string }): unknown }; getCurrentRunId(): string | null | undefined; sendMessage(input: unknown): Promise<unknown> };
  pool: { query: (sqlText: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>; end: () => Promise<void> };
  readPin(): Promise<string | null>;
  cleanup(): Promise<void>;
}

function rid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function buildFixture(opts: {
  seedPin?: string | null;
  holdUser?: boolean;
  missingTask?: boolean;
  nullOrigin?: boolean;
  secondOriginNotice?: boolean;
  secondCompany?: boolean;
  extraTaskOnB?: boolean;
} = {}): Promise<TnFixture> {
  if (!mastraChat || !chatMod) throw new Error('TN plumbing: probeCapabilities() must run first');
  const companyId = rid('tn-co');
  const agentId = rid('tn-ag');
  const companyIdB = rid('tn-cob');
  const agentIdB = rid('tn-agb');
  const bystanderCompanyId = rid('tn-byc');
  const bystanderAgentId = rid('tn-bya');
  const providerId = rid('tn-prov');
  const t1 = rid('tn-t1');
  const t2 = rid('tn-t2');
  const t3 = rid('tn-t3');
  const t9 = rid('tn-t9');
  const t1b = rid('tn-t1b');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

  const insertCompany = async (id: string) => {
    await db.insert(companies).values({ id, name: id, slug: id, issuePrefix: 'TN', status: 'active' });
  };
  await insertCompany(companyId);
  await insertCompany(companyIdB);
  await insertCompany(bystanderCompanyId);
  await db.insert(llmProviders).values({
    id: providerId,
    name: providerId,
    type: 'openai-compatible',
    baseURL: 'http://127.0.0.1:9/never',
    apiKey: 'tn-fake-key',
  });
  await db.insert(agents).values([
    { id: agentId, companyId, name: 'tn-a', role: 'cto', title: 'tn-a', urlKey: agentId, status: 'active', providerId },
    { id: agentIdB, companyId: companyIdB, name: 'tn-b', role: 'cto', title: 'tn-b', urlKey: agentIdB, status: 'active', providerId },
    {
      id: bystanderAgentId,
      companyId: bystanderCompanyId,
      name: 'tn-by',
      role: 'cto',
      title: 'tn-by',
      urlKey: bystanderAgentId,
      status: 'active',
      providerId,
    },
  ]);

  const models = {
    a: makeModel(opts.holdUser === true),
    b: makeModel(false),
    bystander: makeModel(false),
  };
  const unregisters = [
    mastraChat.registerChatModelOverride({ companyId, agentId }, { resolveModel: () => models.a.mock as never }),
    mastraChat.registerChatModelOverride({ companyId: companyIdB, agentId: agentIdB }, { resolveModel: () => models.b.mock as never }),
    mastraChat.registerChatModelOverride(
      { companyId: bystanderCompanyId, agentId: bystanderAgentId },
      { resolveModel: () => models.bystander.mock as never },
    ),
  ];

  const rows = await db.select().from(agents);
  const recordA = rows.find((r) => r.id === agentId)!;
  const recordB = rows.find((r) => r.id === agentIdB)!;
  const controllerA = await chatMod.getOrCreateChatController(recordA as never);
  const controllerB = await chatMod.getOrCreateChatController(recordB as never);
  if (controllerA.id !== mastraChat.buildChatControllerId(agentId)) {
    throw new Error(`TN plumbing: controller identity is not the production formula (${controllerA.id})`);
  }
  if (process.env.TN_CONTROL === 'C-SHARED-IDENTITY') {
    (controllerB as { id: string }).id = controllerA.id;
  }

  const userSession = await chatMod.getChatSession(controllerA, recordA as never, { threadId: t2 });
  // Seed sibling threads on DISTINCT session scopes so we do not switch the user session.
  await chatMod.getChatSession(controllerA, recordA as never, { threadId: t1, scope: `tn-seed:${t1}` });
  await chatMod.getChatSession(controllerA, recordA as never, { threadId: t3, scope: `tn-seed:${t3}` });
  await chatMod.getChatSession(controllerA, recordA as never, { threadId: t9, scope: `tn-seed:${t9}` });
  if (!protoPatched) {
    const proto = Object.getPrototypeOf(userSession);
    const original = proto.queueSignal;
    if (typeof original !== 'function') throw new Error('TN harness: Session.prototype.queueSignal missing');
    proto.queueSignal = function tnQueueSignal(this: { thread?: { getId?: () => string } }, signal: Record<string, unknown>) {
      const attrs = (signal.attributes ?? {}) as Record<string, unknown>;
      signalLog.push({
        threadId: this?.thread?.getId?.() ?? 'unknown',
        taskId: typeof attrs.taskId === 'string' ? attrs.taskId : null,
        stage: typeof attrs.stage === 'string' ? attrs.stage : null,
        tagName: typeof signal.tagName === 'string' ? signal.tagName : null,
        at: new Date().toISOString(),
      });
      const hold = queueHold;
      return (async () => {
        if (hold) await hold;
        return original.call(this, signal);
      })();
    };
    protoPatched = true;
  }

  const insertTask = async (c: string, a: string, origin: string | null, title: string) => {
    const id = rid('tn-task');
    await db.insert(chatTasks).values({
      id,
      companyId: c,
      agentId: a,
      title,
      status: 'pending',
      sourceThreadId: origin,
    });
    return id;
  };
  let taskId = 'tn-missing-task';
  let taskId2 = '';
  let taskIdB = '';
  if (!opts.missingTask) {
    taskId = await insertTask(companyId, agentId, opts.nullOrigin ? null : t1, 'TN bounded prompt');
    if (opts.secondOriginNotice) taskId2 = await insertTask(companyId, agentId, t1, 'TN bounded prompt 2');
  }
  if (opts.secondCompany || opts.extraTaskOnB) {
    taskIdB = await insertTask(companyIdB, agentIdB, t1b, 'TN bounded prompt B');
  }

  const readPin = async (): Promise<string | null> => {
    const res = await pool.query('select thread_id from assistant_active_threads where company_id=$1 and agent_id=$2', [
      companyId,
      agentId,
    ]);
    return (res.rows[0]?.thread_id as string | undefined) ?? null;
  };
  if (opts.seedPin) {
    await pool.query(
      `insert into assistant_active_threads (company_id, agent_id, thread_id, updated_at)
       values ($1,$2,$3, now())
       on conflict (company_id, agent_id) do update set thread_id = excluded.thread_id, updated_at = now()`,
      [companyId, agentId, opts.seedPin === 't9' ? t9 : opts.seedPin === 't3' ? t3 : t2],
    );
  }

  const pinBefore = await readPin();
  const fixture: TnFixture = {
    companyId,
    agentId,
    companyIdB,
    agentIdB,
    providerId,
    t1,
    t2,
    t3,
    t9,
    t1b,
    bystanderCompanyId,
    bystanderAgentId,
    taskId,
    taskId2,
    taskIdB,
    models,
    pinBefore,
    controllerA,
    controllerB,
    recordA,
    recordB,
    userSession: userSession as TnFixture['userSession'],
    pool,
    readPin,
    async cleanup() {
      for (const fn of unregisters) {
        try {
          fn();
        } catch {
          /* idempotent */
        }
      }
      await pool.query('delete from chat_tasks where company_id = any($1)', [[companyId, companyIdB, bystanderCompanyId]]).catch(() => {});
      await pool.query('delete from assistant_active_threads where company_id = any($1)', [[companyId, companyIdB, bystanderCompanyId]]).catch(() => {});
      await pool.query('delete from agents where id = any($1)', [[agentId, agentIdB, bystanderAgentId]]).catch(() => {});
      await pool.query('delete from companies where id = any($1)', [[companyId, companyIdB, bystanderCompanyId]]).catch(() => {});
      await pool.query('delete from llm_providers where id = $1', [providerId]).catch(() => {});
      await pool.end().catch(() => {});
    },
  };
  return fixture;
}

export function progressEvent(f: Pick<TnFixture, 'companyId' | 'agentId' | 'taskId'>, over: Record<string, unknown> = {}) {
  return {
    companyId: f.companyId,
    agentId: f.agentId,
    chatTaskId: f.taskId,
    runId: rid('tn-run'),
    stage: 'done',
    status: 'succeeded',
    title: 'TN bounded task',
    ...over,
  };
}

let bridgeHandle: { ready: Promise<void>; stop: () => Promise<unknown> } | null = null;
export const bridgeLog: Array<Record<string, unknown>> = [];

export async function bridgeStart(opts: Record<string, unknown> = {}): Promise<void> {
  if (!bridgeMod) throw new Error('TN plumbing: bridge module missing');
  if (bridgeHandle) return;
  bridgeLog.length = 0;
  const control = process.env.TN_CONTROL;
  const extra: Record<string, unknown> = { ...opts };
  extra.log = {
    warn: (msg: string, data?: Record<string, unknown>) => {
      bridgeLog.push({ msg, ...(data ?? {}) });
    },
  };
  if (control === 'C-PIN-RESTORE') {
    extra.getTaskOrigin = async (event: { companyId: string; agentId: string }) => {
      const res = await fixturePinLookup(event.companyId, event.agentId);
      if (res) return { threadId: res };
      return bridgeMod!.getTaskOriginFromDb(event as never);
    };
  }
  if (control === 'C-SCOPE-LOOKUP') {
    extra.getTaskOrigin = async (event: { chatTaskId: string }) => {
      const rows = await db.select().from(chatTasks);
      const row = rows.find((r) => r.id === event.chatTaskId);
      if (!row) return { skip: 'task-not-found' };
      if (!row.sourceThreadId) return { skip: 'missing-origin' };
      return { threadId: row.sourceThreadId };
    };
  }
  if (control === 'C-HIJACK') {
    extra.deliver = async (agent: { id: string; companyId: string }, threadId: string, payload: unknown) => {
      const chat = chatMod!;
      const record = (await db.select().from(agents)).find((r) => r.id === agent.id);
      const controller = await chat.getOrCreateChatController(record as never);
      const session = await chat.getChatSession(controller, record as never, { threadId: undefined });
      session.thread.switch({ threadId });
      const { queueTaskProgressSignal } = await import('./task-progress-signals');
      await queueTaskProgressSignal(session as never, payload as never);
      return true;
    };
  }
  const handle = bridgeMod.startTaskProgressSignalBridge(extra as never);
  bridgeHandle = handle;
  await handle.ready;
}

async function fixturePinLookup(companyId: string, agentId: string): Promise<string | null> {
  const rows = (await db.execute(
    sql`select thread_id from assistant_active_threads where company_id = ${companyId} and agent_id = ${agentId}`,
  )) as unknown;
  const arr = (Array.isArray(rows) ? rows : ((rows as { rows?: Array<{ thread_id: string }> }).rows ?? [])) as Array<{
    thread_id: string;
  }>;
  return arr[0]?.thread_id ?? null;
}

export async function bridgeStop(): Promise<unknown> {
  if (!bridgeHandle) return null;
  const handle = bridgeHandle;
  bridgeHandle = null;
  try {
    return await handle.stop();
  } finally {
    await bridgeMod?.__resetTaskProgressSignalBridgeForTests();
  }
}

export async function bridgeReset(): Promise<void> {
  if (bridgeHandle) await bridgeHandle.stop().catch(() => {});
  bridgeHandle = null;
  await bridgeMod?.__resetTaskProgressSignalBridgeForTests();
}

export function bridgeCurrentHandle() {
  return bridgeHandle;
}

export async function withAckGate<T>(fn: () => Promise<T>, gate: Promise<void>): Promise<T> {
  const probe = new Redis(process.env.REDIS_URL as string, { lazyConnect: true });
  const proto = Object.getPrototypeOf(probe) as { psubscribe: (...args: unknown[]) => unknown };
  const original = proto.psubscribe;
  proto.psubscribe = async function gated(this: unknown, ...args: unknown[]) {
    await gate;
    return original.apply(this, args);
  };
  try {
    return await fn();
  } finally {
    proto.psubscribe = original;
    probe.disconnect();
  }
}

export async function runHeldUser(f: TnFixture): Promise<{ pending: Promise<unknown> }> {
  if (!chatMod) throw new Error('TN plumbing: chat module missing');
  tnTrace('runHeldUser:start', { t2: f.t2 });
  const session = await chatMod.getChatSession(f.controllerA as never, f.recordA as never, { threadId: f.t2 });
  let sendError: unknown;
  const pending = Promise.resolve(session.sendMessage({ content: 'TN-HOLD-USER please hold' })).catch((err: unknown) => {
    sendError = err;
    tnTrace('runHeldUser:sendError', { err: String(err) });
    return err;
  });
  try {
    await waitFor(
      'held model entered',
      async () => f.models.a.callLog.some((c) => !c.notice) || sendError != null,
      20_000,
    );
  } catch (err) {
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}; sendError=${String(sendError)}; callLog=${JSON.stringify(f.models.a.callLog)}; thread=${session.thread.getId()}`,
    );
  }
  if (sendError) throw sendError instanceof Error ? sendError : new Error(String(sendError));
  await waitFor('held run id', async () => !!session.getCurrentRunId(), 15_000);
  tnTrace('runHeldUser:held', { thread: session.thread.getId(), runId: session.getCurrentRunId(), calls: f.models.a.callLog.length });
  // Box the in-flight sendMessage. `return pending` from an async function would
  // unwrap/await it, so `await runHeldUser()` waited for the held T2 turn to
  // finish — which only happens after releaseChunks — and never reached publish.
  // Contract R3 / C-BUSY-OTHER-DROP: T1 must persist while that T2 hold is open.
  return { pending };
}

export const TASK_PROGRESS_DRAIN_TIMEOUT_MS = 10_000;

export class TaskProgressBridgeStopError extends Error {
  readonly report: Record<string, unknown>;
  constructor(message: string, report: Record<string, unknown> = {}) {
    super(message);
    this.name = 'TaskProgressBridgeStopError';
    this.report = report;
  }
}
