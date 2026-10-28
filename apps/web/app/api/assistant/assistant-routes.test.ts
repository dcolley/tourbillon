/**
 * UI-2: assistant sidebar API — /api/assistant/agents and /api/assistant/agents/[agentId]/threads[/threadId].
 * Auth/company scope, thread list scoping, search, rename, pin, unread, new thread.
 *
 * '@/lib/chat' is mocked only at the registry boundary (agent resolution mirrors the chat routes:
 * no active company → ActiveCompanyError, other company's agent → 404). Sessions come from a real
 * Mastra AgentController on in-memory storage with a stub model, so thread data is real Mastra memory.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { chatItemsFromStoredMessages } from '../../../lib/agui/client/thread-history';

const mastraRequire = createRequire(join(__dirname, '../../../../../packages/mastra/package.json'));

type Json = Record<string, any>;
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const AGENTS = [
  { id: 'agent-a', urlKey: 'alice', name: 'Alice', companyId: 'company-a', status: 'active' },
  { id: 'agent-b', urlKey: 'bob', name: 'Bob', companyId: 'company-a', status: 'active' },
  { id: 'agent-x', urlKey: 'xavier', name: 'Xavier', companyId: 'company-x', status: 'active' },
  { id: 'agent-z', urlKey: 'zed', name: 'Zed', companyId: 'company-a', status: 'archived' },
];
const RESOURCE_A = 'company-company-a:chat:free';

let activeCompany: { id: string; settings?: unknown } | null = { id: 'company-a' };
let controller: any;
let sessions: Map<string, any>;
const sessionCalls: Array<{
  agentId: string;
  resourceId?: string;
  scope?: string;
  createInitialThread?: boolean;
  threadId?: string;
}> = [];
const loaderCalls: string[] = [];
let viewer = 'user-1';
/** When set, session.thread.list() returns every resource's threads (as a broader storage query would). */
let listAllResources = false;
/** Calls to Mastra session write paths the assistant API must not use for rename/pin. */
const sessionWrites: string[] = [];
/** Calls into the single-statement thread store. */
const storeCalls: string[] = [];
/** Per-user pins, as the assistant_thread_pins table holds them. */
let pins: Map<string, { userKey: string; companyId: string; agentId: string; threadId: string; at: number }>;
/** ASYNC-0 Slice B: assistant_active_threads, keyed `${companyId}::${agentId}`. */
let activeThreads: Map<string, string>;
let pinSeq = 0;

class ChatAgentError extends Error {
  constructor(message: string, readonly status = 404) {
    super(message);
  }
}
class ActiveCompanyError extends Error {
  constructor() {
    super('No active company selected');
  }
}

async function createMemoryController() {
  const { AgentController } = mastraRequire('@mastra/core/agent-controller');
  const { Agent } = mastraRequire('@mastra/core/agent');
  const { MastraLanguageModelV2Mock, simulateReadableStream } = mastraRequire('@mastra/core/test-utils/llm-mock');
  const { InMemoryStore } = mastraRequire('@mastra/core/storage');
  const { Memory } = mastraRequire('@mastra/memory');
  let n = 0;
  const model = new MastraLanguageModelV2Mock({
    doStream: async () => {
      n += 1;
      const id = `t${n}`;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id },
            { type: 'text-delta', id, delta: `reply ${n}` },
            { type: 'text-end', id },
            { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
  const storage = new InMemoryStore();
  const c = new AgentController({
    id: 'assistant-test-controller',
    storage,
    memory: new Memory({ storage, options: { lastMessages: 20, semanticRecall: false } }),
    agent: new Agent({ id: 'stub-agent', name: 'Stub', instructions: 'Test agent.', model }),
    modes: [{ id: 'default', name: 'Default', default: true, defaultModelId: 'stub/stub' }],
    initialState: { yolo: true },
  });
  await c.init();
  return c;
}

const session = async (resourceId: string, scope: string, createInitialThread = false) => {
  const key = `${resourceId}::${scope}`;
  if (!sessions.has(key)) {
    sessions.set(
      key,
      await controller.createSession({ resourceId, id: key, ownerId: controller.id, scope, createInitialThread }),
    );
  }
  return sessions.get(key);
};

/** Seed a thread the way the chat pane does (create, tag) and optionally run one turn on it. */
async function seedThread(opts: {
  id: string;
  title: string;
  agentId?: string;
  resourceId?: string;
  turn?: boolean;
}) {
  await new Promise((r) => setTimeout(r, 5)); // distinct timestamps for ordering
  const s = await session(opts.resourceId ?? RESOURCE_A, `seed-${opts.id}`);
  await s.thread.create({ id: opts.id, title: opts.title });
  if (opts.agentId) await s.thread.setSetting({ key: 'agentId', value: opts.agentId });
  if (opts.turn) await s.sendMessage({ content: `hello ${opts.id}` });
}

let agentsGET: (req: NextRequest) => Promise<Response>;
let threadsGET: Handler;
let threadsPOST: Handler;
let threadPATCH: Handler;
let threadGET: Handler;
let messagesGET: Handler;
let resetThreadCreateLimitForTests: () => void;
let threadsLib: typeof import('../../../lib/assistant/threads');

const req = (url: string, init: { method?: string; body?: unknown } = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
  });
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

async function list(agentId: string, query = ''): Promise<{ status: number; body: Json }> {
  const res = await threadsGET(req(`/api/assistant/agents/${agentId}/threads${query}`), ctx({ agentId }));
  return { status: res.status, body: (await res.json()) as Json };
}
async function getThread(agentId: string, threadId: string): Promise<{ status: number; body: Json }> {
  const res = await threadGET(req(`/api/assistant/agents/${agentId}/threads/${threadId}`), ctx({ agentId, threadId }));
  return { status: res.status, body: (await res.json()) as Json };
}
async function patch(agentId: string, threadId: string, body: unknown): Promise<{ status: number; body: Json }> {
  const res = await threadPATCH(
    req(`/api/assistant/agents/${agentId}/threads/${threadId}`, { method: 'PATCH', body }),
    ctx({ agentId, threadId }),
  );
  return { status: res.status, body: (await res.json()) as Json };
}

async function messages(agentId: string, threadId: string): Promise<{ status: number; body: Json; headers: Headers }> {
  const res = await messagesGET(
    req(`/api/assistant/agents/${agentId}/threads/${threadId}/messages`),
    ctx({ agentId, threadId }),
  );
  return { status: res.status, body: (await res.json()) as Json, headers: res.headers };
}

/** Session proxy: records rename/switch/pin-metadata writes; optionally lists across resources. */
function watched(s: any) {
  const thread = new Proxy(s.thread, {
    get(target, prop: string) {
      const v = target[prop];
      if (typeof v !== 'function') return v;
      if (prop === 'list') {
        return (opts?: Json) => target.list(listAllResources ? { ...opts, allResources: true } : opts);
      }
      if (prop === 'rename' || prop === 'switch') {
        return (...args: unknown[]) => {
          sessionWrites.push(prop);
          return v.apply(target, args);
        };
      }
      if (prop === 'setSettingOn' || prop === 'setSetting') {
        return (arg: Json) => {
          sessionWrites.push(`${prop}:${arg.key}`);
          return v.call(target, arg);
        };
      }
      return v.bind(target);
    },
  });
  return new Proxy(s, { get: (target, prop) => (prop === 'thread' ? thread : target[prop]) });
}

type Scope = { threadId: string; resourceId: string; agentId: string };
type PinScope = { userKey: string; companyId: string; agentId: string };
const MAX_PINS = 50;
/** In-memory stand-in for lib/assistant/thread-store (its SQL is covered in thread-store.test.ts). */
const memoryThreadStore = {
  ASSISTANT_MAX_PINS_PER_AGENT: MAX_PINS,
  async renameAssistantThreadRow(scope: Scope, title: string) {
    storeCalls.push('rename');
    const mem = await controller.getMemoryStorage();
    const t = await mem.getThreadById({ threadId: scope.threadId });
    if (!t || t.resourceId !== scope.resourceId || t.metadata?.agentId !== scope.agentId) return false;
    await mem.updateThread({ id: t.id, title, metadata: {} });
    return true;
  },
  async markAssistantThreadReadRow(scope: Scope, messageId: string) {
    storeCalls.push('read');
    const mem = await controller.getMemoryStorage();
    const t = await mem.getThreadById({ threadId: scope.threadId });
    if (!t || t.resourceId !== scope.resourceId || t.metadata?.agentId !== scope.agentId) return false;
    await mem.updateThread({ id: t.id, title: t.title, metadata: { assistantReadMessageId: messageId } });
    return true;
  },
  async pinAssistantThread(scope: PinScope, threadId: string) {
    storeCalls.push('pin');
    const key = `${scope.userKey}::${threadId}`;
    const others = [...pins.values()].filter(
      (p) => p.userKey === scope.userKey && p.companyId === scope.companyId && p.agentId === scope.agentId && p.threadId !== threadId,
    );
    if (others.length >= MAX_PINS) return false;
    pins.set(key, { ...scope, threadId, at: pins.get(key)?.at ?? ++pinSeq });
    return true;
  },
  async unpinAssistantThread(scope: PinScope, threadId: string) {
    storeCalls.push('unpin');
    const p = pins.get(`${scope.userKey}::${threadId}`);
    if (p && p.companyId === scope.companyId && p.agentId === scope.agentId) pins.delete(`${scope.userKey}::${threadId}`);
  },
  async getActiveAssistantThreadId(scope: { companyId: string; agentId: string }) {
    return activeThreads.get(`${scope.companyId}::${scope.agentId}`) ?? null;
  },
  async setActiveAssistantThread(scope: { companyId: string; agentId: string }, threadId: string) {
    activeThreads.set(`${scope.companyId}::${scope.agentId}`, threadId);
  },
  async claimActiveAssistantThread(scope: { companyId: string; agentId: string }, threadId: string, replacing: string | null) {
    const key = `${scope.companyId}::${scope.agentId}`;
    if ((activeThreads.get(key) ?? null) !== replacing) return false;
    activeThreads.set(key, threadId);
    return true;
  },
  async listPinnedAssistantThreadIds(scope: PinScope) {
    return [...pins.values()]
      .filter((p) => p.userKey === scope.userKey && p.companyId === scope.companyId && p.agentId === scope.agentId)
      .sort((a, b) => b.at - a.at)
      .map((p) => p.threadId);
  },
};

async function post(agentId: string, body: unknown = {}): Promise<{ status: number; body: Json; headers: Headers }> {
  const res = await threadsPOST(req(`/api/assistant/agents/${agentId}/threads`, { method: 'POST', body }), ctx({ agentId }));
  return { status: res.status, body: (await res.json()) as Json, headers: res.headers };
}

describe('UI-2 assistant sidebar API', () => {
  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      if (id === '@/lib/company') {
        return {
          ActiveCompanyError,
          getActiveCompanyOrNull: async () => activeCompany,
          getActiveCompany: async () => {
            if (!activeCompany) throw new ActiveCompanyError();
            return activeCompany;
          },
        };
      }
      if (id === '@/lib/mobile-auth') return { verifyMobileToken: async () => null };
      if (id === '@/lib/assistant/viewer') return { assistantViewerKey: async () => viewer };
      if (id === '@/lib/assistant/thread-store') return memoryThreadStore;
      if (id === '@/lib/assistant/agents') {
        return {
          listAssistantAgents: async (companyId: string) => {
            loaderCalls.push(companyId);
            return AGENTS.filter((a) => a.companyId === companyId && a.status !== 'archived').map((a) => ({ id: a.id, name: a.name }));
          },
        };
      }
      if (id === '@/lib/chat') {
        return {
          ChatAgentError,
          chatResourceId: (companyId: string) => `company-${companyId}:chat:free`,
          resolveChatAgent: async (key: string) => {
            if (!activeCompany) throw new ActiveCompanyError();
            const agent = AGENTS.find((a) => (a.id === key || a.urlKey === key) && a.companyId === activeCompany!.id);
            if (!agent) throw new ChatAgentError('Agent not found', 404);
            return agent;
          },
          getOrCreateChatController: async () => controller,
          listCachedChatControllersForAgent: async () => [controller],
          getChatSession: async (
            _c: unknown,
            agent: { id: string },
            opts: {
              resourceId?: string;
              scope?: string;
              createInitialThread?: boolean;
              threadId?: string;
              tags?: Record<string, string>;
            },
          ) => {
            sessionCalls.push({
              agentId: agent.id,
              resourceId: opts.resourceId,
              scope: opts.scope,
              createInitialThread: opts.createInitialThread,
              ...(opts.threadId ? { threadId: opts.threadId } : {}),
            });
            if (opts.threadId) {
              // Same arguments as lib/chat/registry.ts getChatSession for a session opened on a thread id.
              return watched(
                await controller.createSession({
                  resourceId: opts.resourceId,
                  id: opts.threadId,
                  ownerId: controller.id,
                  tags: opts.tags,
                  scope: opts.scope,
                  threadId: opts.threadId,
                }),
              );
            }
            // Same default as the controller: create an empty thread unless told not to.
            return watched(await session(opts.resourceId!, opts.scope!, opts.createInitialThread !== false));
          },
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ GET: agentsGET } = await import('./agents/route'));
    ({ GET: threadsGET, POST: threadsPOST } = (await import('./agents/[agentId]/threads/route')) as any);
    ({ PATCH: threadPATCH, GET: threadGET } = (await import('./agents/[agentId]/threads/[threadId]/route')) as any);
    ({ GET: messagesGET } = (await import('./agents/[agentId]/threads/[threadId]/messages/route')) as any);
    ({ resetThreadCreateLimitForTests } = await import('../../../lib/assistant/create-limit'));
    threadsLib = await import('../../../lib/assistant/threads');
  });

  beforeEach(async () => {
    activeCompany = { id: 'company-a' };
    controller = await createMemoryController();
    sessions = new Map();
    sessionCalls.length = 0;
    loaderCalls.length = 0;
    sessionWrites.length = 0;
    storeCalls.length = 0;
    pins = new Map();
    activeThreads = new Map();
    viewer = 'user-1';
    listAllResources = false;
    resetThreadCreateLimitForTests();
  });

  describe('auth and company scope', () => {
    it('agents: no active company (or agent token) → 401; otherwise the active company only', async () => {
      activeCompany = null;
      assert.equal((await agentsGET(req('/api/assistant/agents'))).status, 401);
      assert.deepEqual(loaderCalls, []);

      activeCompany = { id: 'company-a' };
      const res = await agentsGET(req('/api/assistant/agents'));
      assert.equal(res.status, 200);
      const body = (await res.json()) as Json;
      assert.equal(body.companyId, 'company-a');
      assert.deepEqual(body.agents.map((a: Json) => a.id), ['agent-a', 'agent-b']);
      assert.deepEqual(loaderCalls, ['company-a']);
    });

    it('threads: no active company → 400; another company’s agent → 404; nothing opened', async () => {
      activeCompany = null;
      assert.equal((await list('alice')).status, 400);
      assert.equal((await patch('alice', 't', { pinned: true })).status, 400);
      activeCompany = { id: 'company-a' };
      assert.equal((await list('xavier')).status, 404);
      assert.equal((await list('agent-x')).status, 404);
      assert.equal((await patch('xavier', 't', { pinned: true })).status, 404);
      assert.deepEqual(sessionCalls, []);
    });

    it('uses the company free-chat resource and its own session scope, without creating threads', async () => {
      await list('alice');
      assert.deepEqual(sessionCalls, [
        { agentId: 'agent-a', resourceId: RESOURCE_A, scope: 'assistant', createInitialThread: false },
      ]);
      // Opening the assistant session leaves no empty thread behind.
      assert.deepEqual(await (await session(RESOURCE_A, 'check')).thread.list(), []);
    });
  });

  describe('thread list', () => {
    beforeEach(async () => {
      await seedThread({ id: 'own-old', title: 'Weekly plan', agentId: 'agent-a', turn: true });
      await seedThread({ id: 'own-new', title: 'Budget review', agentId: 'agent-a', turn: true });
      await seedThread({ id: 'shared', title: 'Shared plan notes' });
      await seedThread({ id: 'bobs', title: 'Bob plan', agentId: 'agent-b', turn: true });
      await seedThread({ id: 'issue-ctx', title: 'Issue plan', agentId: 'agent-a', resourceId: 'company-company-a:chat:issue:7' });
      await seedThread({ id: 'other-co', title: 'Other plan', agentId: 'agent-a', resourceId: 'company-company-x:chat:free' });
    });

    it('lists only the agent’s own threads in the active company, latest activity first', async () => {
      const { status, body } = await list('alice');
      assert.equal(status, 200);
      assert.equal(body.agentId, 'agent-a');
      assert.deepEqual(
        body.threads.map((t: Json) => [t.id, t.agentId, t.unread, t.pinned]),
        [
          ['own-new', 'agent-a', true, false],
          ['own-old', 'agent-a', true, false],
        ],
      );
      assert.equal(body.initialThreadId, 'own-new');
      const bob = await list('bob');
      assert.deepEqual(bob.body.threads.map((t: Json) => t.id), ['bobs']);
      assert.equal(bob.body.initialThreadId, 'bobs');
    });

    it('search filters by title (case-insensitive) and does not pick an initial thread', async () => {
      const { body } = await list('alice', '?q=PLAN');
      assert.deepEqual(body.threads.map((t: Json) => t.id), ['own-old']);
      assert.equal(body.initialThreadId, null);
      assert.deepEqual((await list('alice', '?q=nomatch')).body.threads, []);
      assert.equal((await list('alice', '?limit=1')).body.threads.length, 1);
    });

    it('rename persists and is visible to the chat pane’s Mastra thread', async () => {
      const r = await patch('alice', 'own-old', { title: '  Q3 plan  ' });
      assert.equal(r.status, 200);
      assert.equal(r.body.thread.title, 'Q3 plan');
      const { body } = await list('alice', '?q=q3');
      assert.deepEqual(body.threads.map((t: Json) => t.id), ['own-old']);
      const stored = await (await session(RESOURCE_A, 'check')).thread.getById({ threadId: 'own-old' });
      assert.equal(stored.title, 'Q3 plan');
    });

    it('pin persists and moves the thread to the top; unpin restores order', async () => {
      assert.equal((await patch('alice', 'own-old', { pinned: true })).body.thread.pinned, true);
      let ids = (await list('alice')).body.threads.map((t: Json) => t.id);
      assert.equal(ids[0], 'own-old');
      assert.equal((await list('alice')).body.initialThreadId, 'own-new', 'pins do not change the initial thread');
      await patch('alice', 'own-old', { pinned: false });
      ids = (await list('alice')).body.threads.map((t: Json) => t.id);
      assert.equal(ids[ids.length - 1], 'own-old');
    });

    it('mark read clears unread until the agent replies again', async () => {
      assert.equal((await patch('alice', 'own-new', { read: true })).body.thread.unread, false);
      const t = (await list('alice')).body.threads.find((x: Json) => x.id === 'own-new');
      assert.equal(t.unread, false);
      const s = await session(RESOURCE_A, 'seed-own-new');
      await s.sendMessage({ content: 'and again' });
      const again = (await list('alice')).body.threads.find((x: Json) => x.id === 'own-new');
      assert.equal(again.unread, true);
    });

    it('threads outside the agent’s view are 404 and untouched', async () => {
      for (const threadId of ['bobs', 'shared', 'issue-ctx', 'other-co', 'missing']) {
        const r = await patch('alice', threadId, { title: 'hijack' });
        assert.equal(r.status, 404, threadId);
        assert.equal(r.body.error, 'Thread not found');
      }
      const s = await session(RESOURCE_A, 'check');
      assert.equal((await s.thread.getById({ threadId: 'bobs' })).title, 'Bob plan');
    });

    it('GET one thread: the agent’s own thread; anything outside its view → 404', async () => {
      const own = await getThread('alice', 'own-old');
      assert.equal(own.status, 200);
      assert.equal(own.body.thread.id, 'own-old');
      assert.equal(own.body.thread.title, 'Weekly plan');
      assert.equal(own.body.thread.agentId, 'agent-a');
      for (const threadId of ['bobs', 'shared', 'issue-ctx', 'other-co', 'missing']) {
        const r = await getThread('alice', threadId);
        assert.equal(r.status, 404, threadId);
        assert.deepEqual(r.body, { error: 'Thread not found' });
      }
      assert.equal((await getThread('xavier', 'own-old')).status, 404);
      activeCompany = null;
      assert.equal((await getThread('alice', 'own-old')).status, 400);
    });

    it('invalid PATCH bodies → 400', async () => {
      for (const body of [{}, { title: '' }, { pinned: 'yes' }, { read: false }, { title: 'x', extra: 1 }, 'not json']) {
        assert.equal((await patch('alice', 'own-old', body)).status, 400, JSON.stringify(body));
      }
    });
  });

  describe('new thread', () => {
    it('creates a thread tagged to the agent in the company resource; it becomes the initial thread', async () => {
      const res = await threadsPOST(
        req('/api/assistant/agents/alice/threads', { method: 'POST', body: { title: 'Fresh start' } }),
        ctx({ agentId: 'alice' }),
      );
      assert.equal(res.status, 201);
      const { thread } = (await res.json()) as Json;
      assert.equal(thread.title, 'Fresh start');
      assert.equal(thread.agentId, 'agent-a');
      assert.equal(thread.unread, false);
      const stored = await (await session(RESOURCE_A, 'check')).thread.getById({ threadId: thread.id });
      assert.equal(stored.resourceId, RESOURCE_A);
      assert.equal(stored.metadata.kind, 'chat');
      assert.equal(stored.metadata.contextType, 'free');
      assert.equal(stored.metadata.agentId, 'agent-a');
      const { body } = await list('alice');
      assert.equal(body.initialThreadId, thread.id);
      assert.deepEqual((await list('bob')).body.threads, []);
    });

    it('creating a thread leaves the shared assistant session on its thread; the one-off session is removed', async () => {
      await seedThread({ id: 'busy', title: 'Busy', agentId: 'agent-a', turn: true });
      await list('alice');
      const shared = sessions.get(`${RESOURCE_A}::assistant`);
      const before = shared.thread.getId();
      assert.equal(before, 'busy');
      const deleted: string[] = [];
      const deleteSession = controller.deleteSession.bind(controller);
      controller.deleteSession = async (o: { resourceId: string; scope?: string }) => {
        deleted.push(o.scope ?? '');
        return deleteSession(o);
      };
      sessionWrites.length = 0;
      const r = await post('alice', { title: 'Second' });
      assert.equal(r.status, 201);
      assert.equal(shared.thread.getId(), before);
      assert.ok(!sessionWrites.includes('switch'));
      const create = sessionCalls.find((c) => c.threadId === r.body.thread.id);
      assert.ok(create && create.scope?.startsWith(threadsLib.ASSISTANT_CREATE_SCOPE_PREFIX), JSON.stringify(sessionCalls));
      assert.deepEqual(deleted, [create.scope]);
      assert.equal(r.body.thread.title, 'Second');
      assert.deepEqual((await list('alice')).body.threads.map((t: Json) => t.id), [r.body.thread.id, 'busy']);
    });

    it('rejects bad bodies and other companies’ agents', async () => {
      const bad = await threadsPOST(
        req('/api/assistant/agents/alice/threads', { method: 'POST', body: { title: 'x', agentId: 'agent-b' } }),
        ctx({ agentId: 'alice' }),
      );
      assert.equal(bad.status, 400);
      const foreign = await threadsPOST(
        req('/api/assistant/agents/xavier/threads', { method: 'POST', body: {} }),
        ctx({ agentId: 'xavier' }),
      );
      assert.equal(foreign.status, 404);
    });
  });
  describe('ASYNC-0 Slice B: pinned active thread + AgentController/OM continuity', () => {
    const AGUI_SCOPE = 'agui:agent-a';
    /** A turn on an existing thread, as a late reply / tool result landing on it would add activity. */
    async function turnOn(threadId: string) {
      await new Promise((r) => setTimeout(r, 5));
      const s = await session(RESOURCE_A, `late-${threadId}`);
      await s.thread.switch({ threadId });
      await s.sendMessage({ content: `late message on ${threadId}` });
    }

    it('after Clear, activity on the old thread cannot revive it (latest-by-activity is not used)', async () => {
      await seedThread({ id: 'before-clear', title: 'Before', agentId: 'agent-a', turn: true });
      // First open backfills the pin with the agent's latest thread.
      assert.equal((await list('alice')).body.initialThreadId, 'before-clear');
      assert.equal(activeThreads.get('company-a::agent-a'), 'before-clear');

      const cleared = await post('alice');
      assert.equal(cleared.status, 201);
      const fresh = cleared.body.thread.id as string;
      assert.equal(cleared.body.activeThreadId, fresh);
      assert.equal(activeThreads.get('company-a::agent-a'), fresh);

      // The pre-Clear thread gets newer activity than the fresh (still empty) thread...
      await turnOn('before-clear');
      const after = await list('alice');
      assert.equal(after.body.threads[0].id, 'before-clear', 'it is the latest by activity');
      // ...but the chat still opens the pinned fresh thread.
      assert.equal(after.body.initialThreadId, fresh);
    });

    it('a remount (fresh GET, no thread id) reopens the pinned thread every time', async () => {
      await seedThread({ id: 'older', title: 'Older', agentId: 'agent-a', turn: true });
      await seedThread({ id: 'newer', title: 'Newer', agentId: 'agent-a', turn: true });
      activeThreads.set('company-a::agent-a', 'older');
      for (let i = 0; i < 2; i++) assert.equal((await list('alice')).body.initialThreadId, 'older');
      // Another agent's pin is its own.
      await seedThread({ id: 'bobs', title: 'Bob', agentId: 'agent-b', turn: true });
      assert.equal((await list('bob')).body.initialThreadId, 'bobs');
      assert.equal(activeThreads.get('company-a::agent-a'), 'older');
    });

    it('a pinned thread that vanished or is out of scope falls back to the latest and re-pins it', async () => {
      await seedThread({ id: 'mine', title: 'Mine', agentId: 'agent-a', turn: true });
      await seedThread({ id: 'bobs', title: 'Bob', agentId: 'agent-b', turn: true });
      activeThreads.set('company-a::agent-a', 'bobs'); // another agent's thread is never opened for Alice
      assert.equal((await list('alice')).body.initialThreadId, 'mine');
      assert.equal(activeThreads.get('company-a::agent-a'), 'mine');
      activeThreads.set('company-a::agent-a', 'deleted-thread');
      assert.equal((await list('alice')).body.initialThreadId, 'mine');
      // No threads at all: nothing to open (the client creates the first one, which is pinned).
      const none = await list('zed');
      assert.equal(none.body.initialThreadId, null);
      assert.equal(activeThreads.has('company-a::agent-z'), false);
    });

    it('Clear moves the agent’s idle AG-UI session (and so its thread-scoped OM) to the new thread', async () => {
      await seedThread({ id: 'before-clear', title: 'Before', agentId: 'agent-a', turn: true });
      await seedThread({ id: 'bobs', title: 'Bob', agentId: 'agent-b', turn: true });
      const agui = await session(RESOURCE_A, AGUI_SCOPE);
      await agui.thread.switch({ threadId: 'before-clear' });
      const bobAgui = await session(RESOURCE_A, 'agui:agent-b');
      await bobAgui.thread.switch({ threadId: 'bobs' });
      const shared = await session(RESOURCE_A, 'assistant');
      await shared.thread.switch({ threadId: 'before-clear' });

      const fresh = (await post('alice')).body.thread.id as string;
      // The AG-UI session the chat runs on is now on the new thread under the free-chat resource: the
      // AgentController session and Observational Memory (thread scope: keyed by resource + thread)
      // continue on the new conversation.
      assert.equal(agui.thread.getId(), fresh);
      assert.equal(agui.identity.getResourceId(), RESOURCE_A);
      assert.equal(await controller.getSessionByResource(RESOURCE_A, AGUI_SCOPE), agui);
      // Other agents' sessions and the assistant list session are untouched.
      assert.equal(bobAgui.thread.getId(), 'bobs');
      assert.equal(shared.thread.getId(), 'before-clear');
      // The next open (remount) agrees with the session.
      assert.equal((await list('alice')).body.initialThreadId, fresh);
    });

    it('Clear leaves a session with an open or parked run on its thread (stopping it is offered in the chat)', async () => {
      await seedThread({ id: 'before-clear', title: 'Before', agentId: 'agent-a', turn: true });
      const agui = await session(RESOURCE_A, AGUI_SCOPE);
      await agui.thread.switch({ threadId: 'before-clear' });
      agui.getCurrentRunId = () => 'run-parked-on-card';
      const fresh = (await post('alice')).body.thread.id as string;
      assert.equal(agui.thread.getId(), 'before-clear');
      assert.equal(activeThreads.get('company-a::agent-a'), fresh, 'the pin still moves');
    });

    it('list and create report the agent’s Observational Memory mode', async () => {
      const listed = await list('alice');
      assert.deepEqual(listed.body.observationalMemory, { mode: 'inherit', active: false, heartbeatActive: false });
      const created = await post('alice');
      assert.deepEqual(created.body.observationalMemory, { mode: 'inherit', active: false, heartbeatActive: false });
      // CONCIERGE-OM B1: chat resolves through resolveChatObservationalMemory, so an observer
      // model on the company means OM runs in chat even when heartbeats have it off.
      // Regressing the route to the heartbeat resolver flips `active` back to false here.
      activeCompany = {
        id: 'company-a',
        settings: { observationalMemory: { enabled: false, providerId: 'p1', modelId: 'om-model' } },
      };
      const forced = await list('alice');
      assert.deepEqual(forced.body.observationalMemory, { mode: 'inherit', active: true, heartbeatActive: false });
    });
  });

  describe('tagging and visibility (AG-UI only accepts threads tagged to the agent)', () => {
    beforeEach(async () => {
      await seedThread({ id: 'own', title: 'Own', agentId: 'agent-a', turn: true });
      await seedThread({ id: 'untagged', title: 'Untagged', turn: true });
      await seedThread({ id: 'blank-owner', title: 'Blank owner', agentId: '' });
    });

    it('untagged threads are never offered and cannot be changed', async () => {
      const { body } = await list('alice');
      assert.deepEqual(body.threads.map((t: Json) => t.id), ['own']);
      assert.deepEqual((await list('bob')).body.threads, []);
      for (const threadId of ['untagged', 'blank-owner']) {
        assert.equal((await patch('alice', threadId, { pinned: true })).status, 404, threadId);
        assert.equal((await patch('alice', threadId, { read: true })).status, 404, threadId);
      }
      assert.equal(pins.size, 0);
    });

    it('every created thread is tagged kind=chat, contextType=free and agentId, with or without a title', async () => {
      for (const body of [{}, { title: 'Named' }]) {
        const r = await post('alice', body);
        assert.equal(r.status, 201);
        const stored = await (await session(RESOURCE_A, 'check')).thread.getById({ threadId: r.body.thread.id });
        assert.equal(stored.metadata.kind, 'chat');
        assert.equal(stored.metadata.contextType, 'free');
        assert.equal(stored.metadata.agentId, 'agent-a');
        assert.equal(r.body.thread.agentId, 'agent-a');
        assert.ok((await list('alice')).body.threads.some((t: Json) => t.id === r.body.thread.id));
      }
    });
  });

  describe('free-chat resource filter and activity time', () => {
    beforeEach(async () => {
      await seedThread({ id: 'own', title: 'Own plan', agentId: 'agent-a', turn: true });
      await seedThread({ id: 'issue-ctx', title: 'Issue plan', agentId: 'agent-a', resourceId: 'company-company-a:chat:issue:7', turn: true });
      await seedThread({ id: 'pane', title: 'Pane plan', agentId: 'agent-a', resourceId: 'company-company-a:chat:agent:agent-a', turn: true });
      await seedThread({ id: 'other-co', title: 'Other plan', agentId: 'agent-a', resourceId: 'company-company-x:chat:free', turn: true });
    });

    it('list keeps only the free-chat resource even when storage returns other resources', async () => {
      listAllResources = true;
      const ids = (await list('alice')).body.threads.map((t: Json) => t.id);
      assert.deepEqual(ids, ['own']);
      assert.deepEqual((await list('alice', '?q=plan')).body.threads.map((t: Json) => t.id), ['own']);
    });

    it('single-thread access is limited to the free-chat resource', async () => {
      listAllResources = true;
      for (const threadId of ['issue-ctx', 'pane', 'other-co']) {
        assert.equal((await patch('alice', threadId, { read: true })).status, 404, threadId);
        assert.equal((await patch('alice', threadId, { pinned: true })).status, 404, threadId);
      }
      assert.equal(pins.size, 0);
    });

    it('a pin row for a thread outside the resource is ignored', async () => {
      pins.set('user-1::pane', { userKey: 'user-1', companyId: 'company-a', agentId: 'agent-a', threadId: 'pane', at: ++pinSeq });
      pins.set('user-1::other-co', { userKey: 'user-1', companyId: 'company-a', agentId: 'agent-a', threadId: 'other-co', at: ++pinSeq });
      assert.deepEqual((await list('alice')).body.threads.map((t: Json) => t.id), ['own']);
    });

    it('a thread with no messages reports its creation time as last activity', async () => {
      const r = await post('alice', { title: 'Empty' });
      assert.ok(r.body.thread.createdAt);
      assert.equal(r.body.thread.lastActivityAt, r.body.thread.createdAt);
      const listed = (await list('alice')).body.threads.find((t: Json) => t.id === r.body.thread.id);
      assert.equal(listed.lastActivityAt, listed.createdAt);
      const withTurn = (await list('alice')).body.threads.find((t: Json) => t.id === 'own');
      assert.notEqual(withTurn.lastActivityAt, withTurn.createdAt);
    });
  });

  describe('archived agents are read-only', () => {
    beforeEach(async () => {
      await seedThread({ id: 'zed-1', title: 'Zed history', agentId: 'agent-z', turn: true });
    });

    it('reads work; create, rename and pin → 409; nothing changes', async () => {
      const l = await list('zed');
      assert.equal(l.status, 200);
      assert.deepEqual(l.body.threads.map((t: Json) => t.id), ['zed-1']);

      const created = await post('zed', { title: 'New' });
      assert.equal(created.status, 409);
      assert.match(created.body.error, /archived/);
      for (const body of [{ title: 'Renamed' }, { pinned: true }, { title: 'Renamed', read: true }]) {
        const r = await patch('zed', 'zed-1', body);
        assert.equal(r.status, 409, JSON.stringify(body));
      }
      assert.equal((await patch('zed', 'zed-1', { read: true })).status, 200, 'mark read is a read');

      const after = (await list('zed')).body.threads;
      assert.deepEqual(after.map((t: Json) => [t.id, t.title, t.pinned]), [['zed-1', 'Zed history', false]]);
      assert.equal(pins.size, 0);
      assert.ok(!storeCalls.includes('rename') && !storeCalls.includes('pin'));
    });
  });

  describe('title validation', () => {
    beforeEach(async () => {
      await seedThread({ id: 'own', title: 'Own', agentId: 'agent-a' });
    });

    it('control characters in titles → 400 without touching storage', async () => {
      for (const title of ['a\u0000b', 'line\nbreak', 'tab\there', 'del\u007f', 'c1\u0085', 'sep\u2028x']) {
        const c = await post('alice', { title });
        assert.equal(c.status, 400, JSON.stringify(title));
        assert.deepEqual(c.body, { error: 'Invalid request body' });
        const r = await patch('alice', 'own', { title });
        assert.equal(r.status, 400, JSON.stringify(title));
        assert.deepEqual(r.body, { error: 'Invalid request body' });
      }
      assert.deepEqual(storeCalls, []);
      assert.equal((await list('alice')).body.threads.length, 1);
      // Surrounding whitespace (including newlines) is trimmed, not refused.
      assert.equal((await patch('alice', 'own', { title: '\n Fine \n' })).body.thread.title, 'Fine');
    });

    it('bidi controls in titles (U+202A–202E, U+2066–2069, U+200E, U+200F, U+061C) → 400 without touching storage', async () => {
      const chars = ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069', '\u200E', '\u200F', '\u061C'];
      for (const title of chars.flatMap((c) => [`evil${c}txt.exe`, `${c}lead`])) {
        assert.equal((await post('alice', { title })).status, 400, JSON.stringify(title));
        const r = await patch('alice', 'own', { title });
        assert.equal(r.status, 400, JSON.stringify(title));
        assert.deepEqual(r.body, { error: 'Invalid request body' });
      }
      assert.deepEqual(storeCalls, []);
      assert.deepEqual((await list('alice')).body.threads.map((t: Json) => t.title), ['Own']);
    });

    it('zero-width characters in titles (U+200B–200D, U+2060, U+FEFF) → 400 without touching storage', async () => {
      const chars = ['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF'];
      for (const title of [...chars.flatMap((c) => [`zero${c}width`, `trail${c}`, `${c}lead`]), '\u200B\u200B']) {
        assert.equal((await post('alice', { title })).status, 400, JSON.stringify(title));
        const r = await patch('alice', 'own', { title });
        assert.equal(r.status, 400, JSON.stringify(title));
        assert.deepEqual(r.body, { error: 'Invalid request body' });
      }
      assert.deepEqual(storeCalls, []);
      // Ordinary non-Latin and right-to-left titles are fine.
      assert.equal((await patch('alice', 'own', { title: 'مرحبا שלום 日本 🚀' })).body.thread.title, 'مرحبا שלום 日本 🚀');
    });

    it('unexpected storage errors → 500 without the error text', async () => {
      const original = memoryThreadStore.renameAssistantThreadRow;
      memoryThreadStore.renameAssistantThreadRow = async () => {
        throw new Error('invalid byte sequence for encoding "UTF8": 0x00 (relation mastra_threads)');
      };
      try {
        const r = await patch('alice', 'own', { title: 'ok' });
        assert.equal(r.status, 500);
        assert.deepEqual(r.body, { error: 'Internal error' });
      } finally {
        memoryThreadStore.renameAssistantThreadRow = original;
      }
    });
  });

  describe('creation limit', () => {
    it('per company: the 21st new thread in a minute → 429 with Retry-After; other companies unaffected', async () => {
      const results = await Promise.all(Array.from({ length: 21 }, (_, i) => post(i % 2 ? 'alice' : 'bob', {})));
      const statuses = results.map((r) => r.status).sort();
      assert.deepEqual(statuses.filter((x) => x === 201).length, 20);
      const limited = results.find((r) => r.status === 429)!;
      assert.ok(limited, 'one request limited');
      assert.match(limited.body.error, /Too many new threads/);
      assert.ok(Number(limited.headers.get('retry-after')) >= 1);
      const all = await (await session(RESOURCE_A, 'check')).thread.list();
      assert.equal(all.length, 20, 'the limited request created nothing');

      activeCompany = { id: 'company-x' };
      assert.equal((await post('xavier', {})).status, 201);
    });

    it('invalid and archived requests do not use up the limit', async () => {
      for (let i = 0; i < 25; i++) {
        assert.equal((await post('alice', { title: '' })).status, 400);
        assert.equal((await post('zed', {})).status, 409);
      }
      assert.equal((await post('alice', {})).status, 201);
    });

    it('pinned threads are loaded outside the newest-N scan', async () => {
      await seedThread({ id: 'old-pinned', title: 'Old', agentId: 'agent-a' });
      await seedThread({ id: 'mid', title: 'Mid', agentId: 'agent-a' });
      await seedThread({ id: 'new', title: 'New', agentId: 'agent-a' });
      assert.equal((await patch('alice', 'old-pinned', { pinned: true })).status, 200);
      const agent = AGENTS[0];
      const s = await threadsLib.openAssistantSession(agent);
      const listed = await threadsLib.listAssistantThreads(s, agent, { viewerKey: 'user-1', scanLimit: 1 });
      assert.deepEqual(listed.map((t) => [t.id, t.pinned]), [
        ['old-pinned', true],
        ['new', false],
      ]);
      // Another user's pins do not pull threads in.
      const other = await threadsLib.listAssistantThreads(s, agent, { viewerKey: 'user-2', scanLimit: 1 });
      assert.deepEqual(other.map((t) => t.id), ['new']);
    });
  });

  describe('rename and pin are single writes', () => {
    const N = 15;
    beforeEach(async () => {
      for (let i = 0; i < N; i++) await seedThread({ id: `c${i}`, title: `Thread ${i}`, agentId: 'agent-a' });
    });

    it('concurrent rename + pin on every thread: no lost titles or pins; no session read-modify-write', async () => {
      const ops: Array<Promise<{ status: number }>> = [];
      for (let i = 0; i < N; i++) {
        ops.push(patch('alice', `c${i}`, { title: `Renamed ${i}` }));
        ops.push(patch('alice', `c${i}`, { pinned: true }));
        ops.push(patch('alice', `c${i}`, { read: true }));
      }
      const results = await Promise.all(ops);
      assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
      const threads = (await list('alice', '?limit=200')).body.threads;
      assert.equal(threads.length, N);
      for (const t of threads) {
        const i = t.id.slice(1);
        assert.equal(t.title, `Renamed ${i}`);
        assert.equal(t.pinned, true, t.id);
      }
      assert.deepEqual(
        sessionWrites.filter((w) => w === 'rename' || w === 'switch' || w.startsWith('setSettingOn:assistant')),
        [],
      );
      assert.equal(storeCalls.filter((c) => c === 'rename').length, N);
      assert.equal(storeCalls.filter((c) => c === 'pin').length, N);
    });
  });

  describe('per-user pins', () => {
    beforeEach(async () => {
      await seedThread({ id: 'p1', title: 'One', agentId: 'agent-a' });
      await seedThread({ id: 'p2', title: 'Two', agentId: 'agent-a' });
    });

    it('each user sees only their own pins; nothing is written to thread metadata', async () => {
      viewer = 'user-1';
      assert.equal((await patch('alice', 'p1', { pinned: true })).body.thread.pinned, true);
      viewer = 'user-2';
      let threads = (await list('alice')).body.threads;
      assert.deepEqual(threads.map((t: Json) => [t.id, t.pinned]), [['p2', false], ['p1', false]]);
      assert.equal((await patch('alice', 'p2', { pinned: true })).body.thread.pinned, true);
      threads = (await list('alice')).body.threads;
      assert.deepEqual(threads.map((t: Json) => [t.id, t.pinned]), [['p2', true], ['p1', false]]);

      viewer = 'user-1';
      threads = (await list('alice')).body.threads;
      assert.deepEqual(threads.map((t: Json) => [t.id, t.pinned]), [['p1', true], ['p2', false]]);
      // Unpin is per user too.
      await patch('alice', 'p1', { pinned: false });
      viewer = 'user-2';
      assert.equal((await list('alice')).body.threads.find((t: Json) => t.id === 'p2').pinned, true);

      const s = await session(RESOURCE_A, 'check');
      for (const id of ['p1', 'p2']) {
        const md = (await s.thread.getById({ threadId: id })).metadata;
        assert.ok(!('assistantPinned' in md), id);
      }
    });

    it('pins are scoped to the agent; pinning is idempotent; the per-agent cap → 409', async () => {
      await patch('alice', 'p1', { pinned: true });
      await patch('alice', 'p1', { pinned: true });
      assert.equal(pins.size, 1);
      assert.deepEqual((await list('bob')).body.threads, []);
      // p1 plus MAX_PINS - 1 others: the cap is reached.
      for (let i = 0; i < MAX_PINS - 1; i++) {
        pins.set(`user-1::fake-${i}`, { userKey: 'user-1', companyId: 'company-a', agentId: 'agent-a', threadId: `fake-${i}`, at: ++pinSeq });
      }
      const r = await patch('alice', 'p2', { pinned: true });
      assert.equal(r.status, 409);
      assert.match(r.body.error, /Pin limit/);
      assert.equal((await patch('alice', 'p1', { pinned: true })).status, 200, 're-pinning an existing pin is fine');
    });
  });
  describe('thread messages (P0: the chat loads its transcript every time it opens)', () => {
    beforeEach(async () => {
      await seedThread({ id: 'own', title: 'Own', agentId: 'agent-a', turn: true });
      await seedThread({ id: 'untagged', title: 'Untagged', turn: true });
      await seedThread({ id: 'pane', title: 'Pane', agentId: 'agent-a', resourceId: 'company-company-a:chat:agent:agent-a', turn: true });
    });

    it('returns the persisted messages oldest first, uncached, as the chat shows them', async () => {
      const r = await messages('alice', 'own');
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      const items = chatItemsFromStoredMessages(r.body.messages);
      assert.deepEqual(
        items.map((i) => i.kind),
        ['user', 'assistant'],
      );
      assert.equal((items[0] as { text: string }).text, 'hello own');
      assert.match((items[1] as { text: string }).text, /^reply \d+$/);
      // The assistant text item keeps the stored message id (message feedback is saved under it).
      const assistant = r.body.messages.find((m: Json) => m.role === 'assistant');
      assert.equal(items[1].id, assistant.id);
    });

    it('a later read includes turns written since (no stale copy)', async () => {
      assert.equal((await messages('alice', 'own')).body.messages.length, 2);
      const s = await session(RESOURCE_A, 'seed-own');
      await s.sendMessage({ content: 'second' });
      const items = chatItemsFromStoredMessages((await messages('alice', 'own')).body.messages);
      assert.deepEqual(
        items.map((i) => i.kind),
        ['user', 'assistant', 'user', 'assistant'],
      );
      assert.equal((items[2] as { text: string }).text, 'second');
      assert.match((items[3] as { text: string }).text, /^reply \d+$/);
    });

    it('another agent, an untagged thread or another resource → 404; no active company → 400', async () => {
      assert.equal((await messages('bob', 'own')).status, 404);
      assert.equal((await messages('alice', 'untagged')).status, 404);
      assert.equal((await messages('alice', 'pane')).status, 404);
      assert.equal((await messages('alice', 'missing')).status, 404);
      assert.equal((await messages('xavier', 'own')).status, 404);
      activeCompany = null;
      assert.equal((await messages('alice', 'own')).status, 400);
    });

    describe('CHAT-PAGE-1: paged by query params (limit / before)', () => {
      const page = async (query: string) => {
        const res = await messagesGET(req(`/api/assistant/agents/alice/threads/own/messages?${query}`), {
          params: Promise.resolve({ agentId: 'alice', threadId: 'own' }),
        });
        return { status: res.status, body: (await res.json()) as Json, headers: res.headers };
      };
      beforeEach(async () => {
        // 'own' already holds one turn (2 messages); 12 more turns → 26 messages.
        const s = await session(RESOURCE_A, 'seed-own');
        for (let i = 1; i <= 12; i++) await s.sendMessage({ content: `turn ${i}` });
      });

      it('limit → the newest N oldest-first with hasMore; before → the N strictly older; pages join up exactly', async () => {
        const all = (await messages('alice', 'own')).body;
        assert.equal(all.messages.length, 26);
        assert.equal(all.hasMore, false, 'no paging params: everything, as before');
        const allIds = all.messages.map((m: Json) => m.id);

        const first = await page('limit=10');
        assert.equal(first.status, 200);
        assert.equal(first.headers.get('cache-control'), 'no-store');
        assert.deepEqual(first.body.messages.map((m: Json) => m.id), allIds.slice(16));
        assert.equal(first.body.hasMore, true);

        const second = await page(`limit=10&before=${first.body.messages[0].id}`);
        assert.deepEqual(second.body.messages.map((m: Json) => m.id), allIds.slice(6, 16));
        assert.equal(second.body.hasMore, true);

        const third = await page(`limit=10&before=${second.body.messages[0].id}`);
        assert.deepEqual(third.body.messages.map((m: Json) => m.id), allIds.slice(0, 6));
        assert.equal(third.body.hasMore, false);
        // The pages render as the same transcript as the full read.
        const joined = [...third.body.messages, ...second.body.messages, ...first.body.messages];
        assert.deepEqual(chatItemsFromStoredMessages(joined), chatItemsFromStoredMessages(all.messages));
      });

      it('default page of 20 on open', async () => {
        const r = await page('limit=20');
        assert.equal(r.body.messages.length, 20);
        assert.equal(r.body.hasMore, true);
      });

      it('a cursor far back still pages correctly (window widens)', async () => {
        const allIds = (await messages('alice', 'own')).body.messages.map((m: Json) => m.id);
        const r = await page(`limit=2&before=${allIds[3]}`);
        assert.deepEqual(r.body.messages.map((m: Json) => m.id), allIds.slice(1, 3));
        assert.equal(r.body.hasMore, true);
      });

      it('bad params → 400; a cursor from another thread → 400; scope still enforced (404)', async () => {
        assert.equal((await page('limit=0')).status, 400);
        assert.equal((await page('limit=abc')).status, 400);
        assert.equal((await page('limit=101')).status, 400);
        assert.equal((await page('before=')).status, 400);
        assert.equal((await page('limit=10&before=not-a-message')).status, 400);
        const res = await messagesGET(req('/api/assistant/agents/bob/threads/own/messages?limit=10'), {
          params: Promise.resolve({ agentId: 'bob', threadId: 'own' }),
        });
        assert.equal(res.status, 404);
      });
    });
  });
});
