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

const mastraRequire = createRequire(join(__dirname, '../../../../../packages/mastra/package.json'));

type Json = Record<string, any>;
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const AGENTS = [
  { id: 'agent-a', urlKey: 'alice', name: 'Alice', companyId: 'company-a' },
  { id: 'agent-b', urlKey: 'bob', name: 'Bob', companyId: 'company-a' },
  { id: 'agent-x', urlKey: 'xavier', name: 'Xavier', companyId: 'company-x' },
];
const RESOURCE_A = 'company-company-a:chat:free';

let activeCompany: { id: string } | null = { id: 'company-a' };
let controller: any;
let sessions: Map<string, any>;
const sessionCalls: Array<{ agentId: string; resourceId?: string; scope?: string; createInitialThread?: boolean }> = [];
const loaderCalls: string[] = [];

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
async function patch(agentId: string, threadId: string, body: unknown): Promise<{ status: number; body: Json }> {
  const res = await threadPATCH(
    req(`/api/assistant/agents/${agentId}/threads/${threadId}`, { method: 'PATCH', body }),
    ctx({ agentId, threadId }),
  );
  return { status: res.status, body: (await res.json()) as Json };
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
      if (id === '@/lib/assistant/agents') {
        return {
          listAssistantAgents: async (companyId: string) => {
            loaderCalls.push(companyId);
            return AGENTS.filter((a) => a.companyId === companyId).map((a) => ({ id: a.id, name: a.name }));
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
          getChatSession: async (
            _c: unknown,
            agent: { id: string },
            opts: { resourceId?: string; scope?: string; createInitialThread?: boolean },
          ) => {
            sessionCalls.push({
              agentId: agent.id,
              resourceId: opts.resourceId,
              scope: opts.scope,
              createInitialThread: opts.createInitialThread,
            });
            // Same default as the controller: create an empty thread unless told not to.
            return session(opts.resourceId!, opts.scope!, opts.createInitialThread !== false);
          },
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ GET: agentsGET } = await import('./agents/route'));
    ({ GET: threadsGET, POST: threadsPOST } = (await import('./agents/[agentId]/threads/route')) as any);
    ({ PATCH: threadPATCH } = (await import('./agents/[agentId]/threads/[threadId]/route')) as any);
  });

  beforeEach(async () => {
    activeCompany = { id: 'company-a' };
    controller = await createMemoryController();
    sessions = new Map();
    sessionCalls.length = 0;
    loaderCalls.length = 0;
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

    it('lists the agent’s own and shared threads in the active company only, latest activity first', async () => {
      const { status, body } = await list('alice');
      assert.equal(status, 200);
      assert.equal(body.agentId, 'agent-a');
      assert.deepEqual(
        body.threads.map((t: Json) => [t.id, t.agentId, t.unread, t.pinned]),
        [
          ['shared', null, false, false],
          ['own-new', 'agent-a', true, false],
          ['own-old', 'agent-a', true, false],
        ],
      );
      assert.equal(body.initialThreadId, 'own-new');
      const bob = await list('bob');
      assert.deepEqual(bob.body.threads.map((t: Json) => t.id).sort(), ['bobs', 'shared']);
      assert.equal(bob.body.initialThreadId, 'bobs');
    });

    it('search filters by title (case-insensitive) and does not pick an initial thread', async () => {
      const { body } = await list('alice', '?q=PLAN');
      assert.deepEqual(body.threads.map((t: Json) => t.id).sort(), ['own-old', 'shared']);
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
      for (const threadId of ['bobs', 'issue-ctx', 'other-co', 'missing']) {
        const r = await patch('alice', threadId, { title: 'hijack' });
        assert.equal(r.status, 404, threadId);
        assert.equal(r.body.error, 'Thread not found');
      }
      const s = await session(RESOURCE_A, 'check');
      assert.equal((await s.thread.getById({ threadId: 'bobs' })).title, 'Bob plan');
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
      const { body } = await list('alice');
      assert.equal(body.initialThreadId, thread.id);
      assert.deepEqual((await list('bob')).body.threads, []);
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
});
