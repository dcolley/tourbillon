/**
 * Chat route scoping: every /api/chat/[agentId]/sessions[/resourceId]/* route only acts on chat
 * resources of the active company and on threads the agent may use (its own or untagged shared
 * threads in that resource). Anything else answers 404 and leaves the data untouched.
 *
 * '@/lib/chat' is mocked only at the registry boundary (agent resolution mirrors the registry:
 * agents outside the active company are 404). Sessions come from real Mastra AgentControllers
 * (one per agent, shared in-memory storage, stub model), so thread data is real Mastra memory.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const mastraRequire = createRequire(join(__dirname, '../../../../../packages/mastra/package.json'));

type Json = Record<string, any>;
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const AGENTS = [
  { id: 'agent-a', urlKey: 'alice', name: 'Alice', companyId: 'company-a', modelId: null },
  { id: 'agent-b', urlKey: 'bob', name: 'Bob', companyId: 'company-a', modelId: null },
  { id: 'agent-x', urlKey: 'xavier', name: 'Xavier', companyId: 'company-x', modelId: null },
];
const RES_A = 'company-company-a:chat:free';
const RES_A_ISSUE = 'company-company-a:chat:issue:i-1';
const RES_X = 'company-company-x:chat:free';
const ACTIVE_COMPANY = 'company-a';

class ChatAgentError extends Error {
  constructor(message: string, readonly status = 404) {
    super(message);
  }
}
class ActiveCompanyError extends Error {}

let storage: any;
const controllers = new Map<string, any>();

function stubModel() {
  const { MastraLanguageModelV2Mock, simulateReadableStream } = mastraRequire('@mastra/core/test-utils/llm-mock');
  let n = 0;
  return new MastraLanguageModelV2Mock({
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
}

async function controllerFor(agentId: string) {
  if (!controllers.has(agentId)) {
    const { AgentController } = mastraRequire('@mastra/core/agent-controller');
    const { Agent } = mastraRequire('@mastra/core/agent');
    const { Memory } = mastraRequire('@mastra/memory');
    const c = new AgentController({
      id: `chat-${agentId}`,
      storage,
      memory: new Memory({ storage, options: { lastMessages: 20, semanticRecall: false } }),
      agent: new Agent({ id: `stub-${agentId}`, name: 'Stub', instructions: 'Test agent.', model: stubModel() }),
      modes: [{ id: 'default', name: 'Default', default: true, defaultModelId: 'stub/stub' }],
      initialState: { yolo: true },
    });
    await c.init();
    controllers.set(agentId, c);
  }
  return controllers.get(agentId);
}

/** Mirrors registry.getChatSession (session id = threadId, else resource::scope). */
async function getChatSession(
  controller: any,
  _agent: unknown,
  opts: { resourceId: string; threadId?: string; tags?: Record<string, string>; scope?: string },
) {
  const id = opts.threadId ?? (opts.scope ? `${opts.resourceId}::${opts.scope}` : opts.resourceId);
  return controller.createSession({
    resourceId: opts.resourceId,
    id,
    ownerId: controller.id,
    tags: opts.tags,
    scope: opts.scope,
    threadId: opts.threadId,
  });
}

let seedN = 0;
/** Create a thread the way the chat pane does (create + agentId tag) and run one turn on it. */
async function seedThread(opts: { id: string; agentId: string; resourceId: string; tag?: boolean }) {
  await new Promise((r) => setTimeout(r, 5));
  const c = await controllerFor(opts.agentId);
  seedN += 1;
  const s = await c.createSession({
    resourceId: opts.resourceId,
    id: `seed-${seedN}`,
    ownerId: c.id,
    scope: `seed-${seedN}`,
    createInitialThread: false,
  });
  await s.thread.create({ id: opts.id, title: `title ${opts.id}` });
  if (opts.tag !== false) await s.thread.setSetting({ key: 'agentId', value: opts.agentId });
  await s.sendMessage({ content: `hello ${opts.id}` });
}

async function probe(resourceId: string) {
  const c = await controllerFor('agent-a');
  seedN += 1;
  return c.createSession({ resourceId, id: `probe-${seedN}`, ownerId: c.id, scope: `probe-${seedN}`, createInitialThread: false });
}
async function readThread(resourceId: string, threadId: string) {
  return (await probe(resourceId)).thread.getById({ threadId });
}
async function messageCount(resourceId: string, threadId: string): Promise<number> {
  return ((await (await probe(resourceId)).thread.listMessages({ threadId })) as unknown[]).length;
}
const settle = () => new Promise((r) => setTimeout(r, 300));

async function threadsIn(resourceId: string): Promise<Json[]> {
  return (await (await probe(resourceId)).thread.list()) as Json[];
}

const routes: Record<string, Handler> = {};
let helpers: typeof import('../../../lib/chat/route-helpers');
const enc = encodeURIComponent;

async function call(
  name: string,
  p: { agentId: string; resourceId?: string; threadId?: string },
  init: { body?: unknown; query?: string } = {},
): Promise<{ status: number; body: Json }> {
  const method = name.split(' ')[0];
  const res = await routes[name](
    new NextRequest(`http://localhost/api/chat/${p.agentId}/sessions/${enc(p.resourceId ?? '')}${init.query ?? ''}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(init.body ?? {}),
    }),
    { params: Promise.resolve({ agentId: p.agentId, resourceId: enc(p.resourceId ?? ''), threadId: p.threadId ?? '' }) as never },
  );
  if (res.headers.get('content-type')?.startsWith('text/event-stream')) {
    await res.body?.cancel();
    return { status: res.status, body: {} };
  }
  return { status: res.status, body: (await res.json()) as Json };
}

const ctx = { context: { contextType: 'free' } };
/** Every handler that takes a resourceId, with a body that is valid for it. */
const RESOURCE_ROUTES: Array<[string, unknown?]> = [
  ['GET session'],
  ['POST abort'],
  ['POST follow-up', { message: 'more', ...ctx }],
  ['POST messages', { message: 'hi', ...ctx }],
  ['POST steer', { message: 'steer', ...ctx }],
  ['GET stream'],
  ['POST thread', { threadId: 'x-own' }],
  ['GET threads'],
  ['POST threads', { title: 'New chat' }],
  ['PATCH threads/:threadId', { title: 'Renamed' }],
  ['DELETE threads/:threadId'],
  ['GET threads/:threadId/messages'],
  ['POST tool-approval', { toolCallId: 'tc-1', approved: true }],
];

describe('chat route scoping', () => {
  before(async () => {
    // These routes are off unless the Control Pane chat is enabled on the server and the assistant is off.
    process.env.CONTROL_CHAT_ENABLED = 'true';
    process.env.NEXT_PUBLIC_CONTROL_CHAT_ENABLED = 'true';
    process.env.ASSISTANT_ENABLED = 'false';
    const { InMemoryStore } = mastraRequire('@mastra/core/storage');
    storage = new InMemoryStore();

    const RESERVED = new Set(['currentModelId', 'currentModeId', 'tokenUsage']);
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: unknown, id: string) {
      if (id === '@/lib/chat' || id.endsWith('/lib/chat') || id.endsWith('/lib/chat/index')) {
        return {
          ChatAgentError,
          resolveChatAgent: async (key: string) => {
            const agent = AGENTS.find((a) => (a.id === key || a.urlKey === key) && a.companyId === ACTIVE_COMPANY);
            if (!agent) throw new ChatAgentError('Agent not found', 404);
            return agent;
          },
          getOrCreateChatController: async (agent: { id: string }) => controllerFor(agent.id),
          getChatSession,
          createChatRequestContext: () => undefined,
          // Mirrors buildChatResourceId.
          chatResourceId: (companyId: string, c: { contextType?: string; contextId?: string } = {}) =>
            c.contextId && c.contextType && c.contextType !== 'free'
              ? `company-${companyId}:chat:${c.contextType}:${c.contextId}`
              : `company-${companyId}:chat:free`,
          chatContextFromTags: (tags?: Record<string, string>) => ({
            contextType: tags?.contextType ?? 'free',
            contextId: tags?.contextId,
          }),
          isReservedThreadMetadataKey: (key: string) => RESERVED.has(key),
          extractThreadTags: (metadata: unknown) =>
            Object.fromEntries(
              Object.entries((metadata as Record<string, unknown>) ?? {}).filter(
                ([k, v]) => typeof v === 'string' && !RESERVED.has(k),
              ),
            ),
        };
      }
      if (id === '@/lib/company' || id.endsWith('/lib/company')) return { ActiveCompanyError };
      if (id === '@tourbillon/mastra') {
        return { runWithHeartbeatContext: (_c: unknown, fn: () => Promise<unknown>) => fn() };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    const r = './[agentId]/sessions/[resourceId]';
    routes['POST sessions'] = (await import('./[agentId]/sessions/route')).POST as unknown as Handler;
    routes['GET session'] = (await import(`${r}/route`)).GET as unknown as Handler;
    routes['POST abort'] = (await import(`${r}/abort/route`)).POST as unknown as Handler;
    routes['POST follow-up'] = (await import(`${r}/follow-up/route`)).POST as unknown as Handler;
    routes['POST messages'] = (await import(`${r}/messages/route`)).POST as unknown as Handler;
    routes['POST steer'] = (await import(`${r}/steer/route`)).POST as unknown as Handler;
    routes['GET stream'] = (await import(`${r}/stream/route`)).GET as unknown as Handler;
    routes['POST thread'] = (await import(`${r}/thread/route`)).POST as unknown as Handler;
    const threads = await import(`${r}/threads/route`);
    routes['GET threads'] = threads.GET as unknown as Handler;
    routes['POST threads'] = threads.POST as unknown as Handler;
    const thread = await import(`${r}/threads/[threadId]/route`);
    routes['PATCH threads/:threadId'] = thread.PATCH as unknown as Handler;
    routes['DELETE threads/:threadId'] = thread.DELETE as unknown as Handler;
    routes['GET threads/:threadId/messages'] = (await import(`${r}/threads/[threadId]/messages/route`)).GET as unknown as Handler;
    routes['POST tool-approval'] = (await import(`${r}/tool-approval/route`)).POST as unknown as Handler;
    helpers = await import('../../../lib/chat/route-helpers');
    Module.prototype.require = originalRequire;

    // Other company: one thread. Active company: agent A's thread (newest), B's own thread, a shared one.
    await seedThread({ id: 'x-thread', agentId: 'agent-x', resourceId: RES_X });
    await seedThread({ id: 'b-own', agentId: 'agent-b', resourceId: RES_A });
    await seedThread({ id: 'shared', agentId: 'agent-b', resourceId: RES_A, tag: false });
    await seedThread({ id: 'x-own', agentId: 'agent-a', resourceId: RES_A });
  });

  describe('resource of another company → 404, nothing touched', () => {
    for (const resourceId of [RES_X, 'company-company-a', 'company-company-a:chat:', 'company-company-ab:chat:free', 'free']) {
      for (const [name, body] of RESOURCE_ROUTES) {
        it(`${name} ${resourceId}`, async () => {
          const before = await messageCount(RES_X, 'x-thread');
          const res = await call(name, { agentId: 'alice', resourceId, threadId: 'x-thread' }, { body });
          assert.equal(res.status, 404, JSON.stringify(res.body));
          assert.equal(res.body.error, 'Resource not found');
          await settle();
          assert.equal(await messageCount(RES_X, 'x-thread'), before);
          const x = await readThread(RES_X, 'x-thread');
          assert.equal(x?.title, 'title x-thread');
        });
      }
    }

    it('POST sessions ignores a client-supplied resource id', async () => {
      for (const resourceId of [RES_X, RES_A_ISSUE, 'company-company-a:chat:agent:agent-b', 'anything']) {
        const before = await messageCount(RES_X, 'x-thread');
        const res = await call('POST sessions', { agentId: 'alice' }, { body: { resourceId, sessionScope: 'ignore-res' } });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.resourceId, RES_A, 'resource derived on the server');
        assert.notEqual(res.body.threadId, 'x-thread');
        assert.equal(await messageCount(RES_X, 'x-thread'), before);
      }
      // A thread of the client-named resource is not reachable through it either.
      const res = await call('POST sessions', { agentId: 'alice' }, { body: { resourceId: RES_X, threadId: 'x-thread' } });
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'Thread not found');
      assert.equal((await readThread(RES_X, 'x-thread'))?.title, 'title x-thread');
    });

    it('agent of another company is still 404 (unchanged)', async () => {
      const res = await call('GET threads', { agentId: 'xavier', resourceId: RES_X });
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'Agent not found');
    });
  });

  describe('own company resource still works', () => {
    it('POST sessions (default and context resource)', async () => {
      const res = await call('POST sessions', { agentId: 'bob' }, { body: { sessionScope: 'pos' } });
      assert.equal(res.status, 200);
      assert.equal(res.body.resourceId, RES_A);
      const res2 = await call('POST sessions', { agentId: 'bob' }, {
        body: { tags: { contextType: 'issue', contextId: 'i-1' }, sessionScope: 'issue' },
      });
      assert.equal(res2.status, 200);
      assert.equal(res2.body.resourceId, RES_A_ISSUE);
    });

    it('GET threads lists own then shared, never other agents', async () => {
      const res = await call('GET threads', { agentId: 'bob', resourceId: RES_A });
      assert.equal(res.status, 200);
      const ids = (res.body.threads as Json[]).map((t) => t.id);
      assert.ok(ids.includes('b-own') && ids.includes('shared'));
      assert.ok(!ids.includes('x-own'));
      assert.ok(!ids.includes('x-thread'));
    });

    it('thread switch, rename, messages on own and shared threads', async () => {
      const q = '?sessionScope=own';
      assert.equal((await call('POST thread', { agentId: 'bob', resourceId: RES_A }, { body: { threadId: 'b-own' }, query: q })).status, 200);
      assert.equal((await call('POST thread', { agentId: 'bob', resourceId: RES_A }, { body: { threadId: 'shared' }, query: q })).status, 200);
      const ren = await call('PATCH threads/:threadId', { agentId: 'bob', resourceId: RES_A, threadId: 'b-own' }, { body: { title: 'Mine' }, query: q });
      assert.equal(ren.status, 200);
      assert.equal((await readThread(RES_A, 'b-own'))?.title, 'Mine');
      const msgs = await call('GET threads/:threadId/messages', { agentId: 'bob', resourceId: RES_A, threadId: 'b-own' }, { query: q });
      assert.equal(msgs.status, 200);
      assert.ok((msgs.body.messages as Json[]).length >= 2);
    });

    it('session control routes answer 200 on own resource', async () => {
      const q = '?sessionScope=ctl';
      assert.equal((await call('POST thread', { agentId: 'bob', resourceId: RES_A }, { body: { threadId: 'b-own' }, query: q })).status, 200);
      for (const [name, body] of [
        ['GET session'],
        ['GET stream'],
        ['POST abort'],
        ['POST tool-approval', { toolCallId: 'tc-1', approved: false }],
      ] as Array<[string, unknown?]>) {
        const res = await call(name, { agentId: 'bob', resourceId: RES_A }, { body, query: q });
        assert.equal(res.status, 200, `${name}: ${JSON.stringify(res.body)}`);
      }
    });

    it('POST threads keeps ownership on the caller even when tags say otherwise', async () => {
      const res = await call(
        'POST threads',
        { agentId: 'bob', resourceId: RES_A },
        { body: { title: 'Tagged', tags: { agentId: 'agent-a', kind: 'other', contextType: 'free' } }, query: '?sessionScope=tags' },
      );
      assert.equal(res.status, 200);
      assert.equal(res.body.tags.agentId, 'agent-b');
      assert.equal(res.body.tags.kind, 'chat');
      assert.equal(res.body.tags.contextType, 'free');
      const stored = await readThread(RES_A, res.body.id);
      assert.equal((stored?.metadata as Json).agentId, 'agent-b');
      await call('DELETE threads/:threadId', { agentId: 'bob', resourceId: RES_A, threadId: res.body.id }, { query: '?sessionScope=tags' });
    });

    it('DELETE own thread', async () => {
      await seedThread({ id: 'b-temp', agentId: 'agent-b', resourceId: RES_A });
      const res = await call('DELETE threads/:threadId', { agentId: 'bob', resourceId: RES_A, threadId: 'b-temp' }, { query: '?sessionScope=del' });
      assert.equal(res.status, 200);
      assert.equal(await readThread(RES_A, 'b-temp'), null);
    });
  });

  describe("another agent's thread in the same company → 404, nothing touched", () => {
    const THREAD_ROUTES: Array<[string, unknown?]> = [
      ['POST thread', { threadId: 'x-own' }],
      ['PATCH threads/:threadId', { title: 'Renamed' }],
      ['DELETE threads/:threadId'],
      ['GET threads/:threadId/messages'],
    ];
    for (const [name, body] of THREAD_ROUTES) {
      it(name, async () => {
        const before = await messageCount(RES_A, 'x-own');
        const res = await call(name, { agentId: 'bob', resourceId: RES_A, threadId: 'x-own' }, { body, query: '?sessionScope=t404' });
        assert.equal(res.status, 404, JSON.stringify(res.body));
        assert.equal(res.body.error, 'Thread not found');
        const t = await readThread(RES_A, 'x-own');
        assert.equal(t?.title, 'title x-own');
        assert.equal(await messageCount(RES_A, 'x-own'), before);
      });
    }

    for (const [name, body] of THREAD_ROUTES) {
      it(`${name}: thread from another resource → 404`, async () => {
        const res = await call(name, { agentId: 'bob', resourceId: RES_A, threadId: 'x-thread' }, {
          body: name === 'POST thread' ? { threadId: 'x-thread' } : body,
          query: '?sessionScope=r404',
        });
        assert.equal(res.status, 404, JSON.stringify(res.body));
        assert.equal((await readThread(RES_X, 'x-thread'))?.title, 'title x-thread');
      });
    }

    it('POST sessions with threadId of another agent or resource → 404', async () => {
      const res = await call('POST sessions', { agentId: 'bob' }, { body: { resourceId: RES_A, threadId: 'x-own' } });
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'Thread not found');
      const res2 = await call('POST sessions', { agentId: 'bob' }, { body: { resourceId: RES_A, threadId: 'x-thread' } });
      assert.equal(res2.status, 404);
      assert.equal(res2.body.error, 'Thread not found');
    });

    it("a new session never inherits another agent's newest thread", async () => {
      await seedThread({ id: 'a-newest', agentId: 'agent-a', resourceId: RES_A });
      const q = '?sessionScope=fresh-scope';
      const hydrate = await call('GET session', { agentId: 'bob', resourceId: RES_A }, { query: q });
      assert.equal(hydrate.status, 200);
      assert.notEqual(hydrate.body.threadId, 'a-newest');

      const created = await call('POST sessions', { agentId: 'bob' }, { body: { sessionScope: 'fresh-2' } });
      assert.equal(created.status, 200);
      assert.notEqual(created.body.threadId, 'a-newest');

      const before = await messageCount(RES_A, 'a-newest');
      for (const [name, body] of [
        ['POST abort'],
        ['POST tool-approval', { toolCallId: 'tc-1', approved: true }],
        ['POST messages', { message: 'hi', ...ctx }],
        ['POST follow-up', { message: 'more', ...ctx }],
        ['POST steer', { message: 'steer', ...ctx }],
      ] as Array<[string, unknown?]>) {
        const res = await call(name, { agentId: 'bob', resourceId: RES_A }, { body, query: '?sessionScope=fresh-3' });
        assert.equal(res.status, 200, `${name}: ${JSON.stringify(res.body)}`);
        await settle(); // let the fire-and-forget turn finish before the next control call
      }
      await settle();
      assert.equal(await messageCount(RES_A, 'a-newest'), before);
      assert.equal(((await readThread(RES_A, 'a-newest'))?.metadata as Json).agentId, 'agent-a');
    });

    it('the owner still sees and uses its thread', async () => {
      const res = await call('POST thread', { agentId: 'alice', resourceId: RES_A }, { body: { threadId: 'x-own' }, query: '?sessionScope=owner' });
      assert.equal(res.status, 200);
      const msgs = await call('GET threads/:threadId/messages', { agentId: 'alice', resourceId: RES_A, threadId: 'x-own' }, { query: '?sessionScope=owner' });
      assert.equal(msgs.status, 200);
    });
  });

  describe('ownership tags and explicit threads', () => {
    for (const [i, clientTags] of [
      [1, { agentId: 'agent-a', kind: 'other' }],
      [2, { agentId: '' }],
    ] as Array<[number, Record<string, string>]>) {
      it(`POST sessions forces kind and agentId (client tags ${JSON.stringify(clientTags)})`, async () => {
        const contextId = `p-s1-${i}`;
        const resourceId = `company-company-a:chat:project:${contextId}`;
        const tags = { ...clientTags, contextType: 'project', contextId };
        const q = `?sessionScope=s1-${i}`;
        const res = await call('POST sessions', { agentId: 'bob' }, { body: { tags, sessionScope: `s1-${i}` } });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.resourceId, resourceId);

        const sent = await call('POST messages', { agentId: 'bob', resourceId }, {
          body: { message: 'hi', context: { contextType: 'project', contextId } },
          query: q,
        });
        assert.equal(sent.status, 200);
        await settle();

        const threads = await threadsIn(resourceId);
        assert.ok(threads.length >= 1, 'a thread was created');
        for (const t of threads) {
          assert.equal((t.metadata as Json)?.agentId, 'agent-b', `thread ${t.id} owner`);
          assert.equal((t.metadata as Json)?.kind, 'chat', `thread ${t.id} kind`);
        }
        const asAlice = await call('GET threads', { agentId: 'alice', resourceId });
        assert.equal(asAlice.status, 200);
        assert.equal((asAlice.body.threads as Json[]).length, 0, 'not listed for another agent');
      });
    }

    it('POST threads: client tags do not reach the session or its first thread', async () => {
      const resourceId = 'company-company-a:chat:project:p-m13';
      const res = await call('POST threads', { agentId: 'bob', resourceId }, {
        body: { title: 'T', tags: { agentId: 'agent-a', kind: 'other' } },
        query: '?sessionScope=m13',
      });
      assert.equal(res.status, 200);
      const threads = await threadsIn(resourceId);
      assert.ok(threads.length >= 1);
      for (const t of threads) {
        assert.equal((t.metadata as Json)?.agentId, 'agent-b', `thread ${t.id} owner`);
        assert.equal((t.metadata as Json)?.kind, 'chat', `thread ${t.id} kind`);
      }
    });

    it('POST sessions with a rejected threadId leaves the existing session untouched', async () => {
      await seedThread({ id: 'b-issue', agentId: 'agent-b', resourceId: RES_A_ISSUE });
      const q = '?sessionScope=s2';
      assert.equal((await call('POST thread', { agentId: 'bob', resourceId: RES_A }, { body: { threadId: 'b-own' }, query: q })).status, 200);
      const session = await (await controllerFor('agent-b')).getSessionByResource(RES_A, 's2');
      assert.equal(session.thread.getId(), 'b-own');
      const events: Json[] = [];
      const unsubscribe = session.subscribe((e: Json) => events.push(e));
      try {
        for (const threadId of ['x-own', 'x-thread', 'b-issue']) {
          const res = await call('POST sessions', { agentId: 'bob' }, { body: { threadId, sessionScope: 's2' } });
          assert.equal(res.status, 404, `${threadId}: ${JSON.stringify(res.body)}`);
          assert.equal(res.body.error, 'Thread not found');
          assert.equal(session.thread.getId(), 'b-own', `${threadId}: binding kept`);
        }
        await settle();
        assert.deepEqual(
          events.filter((e) => e.type === 'thread_changed'),
          [],
          'no switch happened',
        );
      } finally {
        unsubscribe();
      }
    });

    it('chatThreadVisibleTo requires the same resource and an own or untagged owner', () => {
      const bob = { id: 'agent-b', companyId: 'company-a' };
      const v = helpers.chatThreadVisibleTo;
      assert.equal(v({ resourceId: RES_A, metadata: { agentId: 'agent-b' } }, bob, RES_A), true);
      assert.equal(v({ resourceId: RES_A, metadata: {} }, bob, RES_A), true);
      assert.equal(v({ resourceId: RES_A }, bob, RES_A), true);
      assert.equal(v({ resourceId: RES_A_ISSUE, metadata: { agentId: 'agent-b' } }, bob, RES_A), false);
      assert.equal(v({ resourceId: RES_A_ISSUE, metadata: {} }, bob, RES_A), false);
      assert.equal(v({ resourceId: RES_X }, bob, RES_A), false);
      assert.equal(v({ metadata: { agentId: 'agent-b' } }, bob, RES_A), false);
      assert.equal(v({ resourceId: RES_A, metadata: { agentId: 'agent-a' } }, bob, RES_A), false);
      assert.equal(v(null, bob, RES_A), false);
    });
  });
});
