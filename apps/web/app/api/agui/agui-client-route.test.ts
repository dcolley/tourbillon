/**
 * AGUI-1b: the assistant-view client (lib/agui/client) end to end against the real
 * POST /api/agui/[agentId] route: a turn with text + a tool call, follow-up / steer / abort mid-run,
 * disconnect (dispose) stopping the run, a run refused with 409, and a second tab opening the same
 * agent (thread bootstrap through lib/assistant/threads) while the first tab's run streams.
 *
 * Same mock boundary as agui-route.test.ts: '@/lib/chat' at the registry, and a real Mastra
 * AgentController on in-memory storage with a stub model.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { AgentChatClient } from '../../../lib/agui/client/agent-chat-client';
import type { AgentChatItem, AgentChatState } from '../../../lib/agui/client/chat-state';
import {
  createStubAgentController,
  createStubRequestContext,
  stubText,
  stubToolCall,
  type StubAgentController,
} from '../../../lib/agui/testing/stub-agent-controller';

type Handler = (req: NextRequest, ctx: { params: Promise<{ agentId: string }> }) => Promise<Response>;

const AGENT = { id: 'agent-a', urlKey: 'alice', name: 'Alice', companyId: 'company-a', modelId: 'm' };
const RESOURCE = 'company-company-a:chat:free';

let stub: StubAgentController;
let sessions: Map<string, unknown>;
let POST: Handler;
let assistant: typeof import('../../../lib/assistant/threads');
let script: (call: number, prompt: Array<{ role: string; content: unknown }>) => Record<string, unknown>[];
let chunkDelayMs = 0;
const requestContext = createStubRequestContext({ chatRequestContext: true });

class ChatAgentError extends Error {
  constructor(
    message: string,
    readonly status = 404,
  ) {
    super(message);
  }
}
class ActiveCompanyError extends Error {}

const routeFetch = (async (url: string, init: RequestInit) =>
  POST(
    new NextRequest(new URL(url, 'http://localhost'), {
      method: 'POST',
      body: init.body as string,
      headers: init.headers as HeadersInit,
      ...(init.signal ? { signal: init.signal } : {}),
    }),
    { params: Promise.resolve({ agentId: 'alice' }) },
  )) as unknown as typeof fetch;

async function seedThread(threadId: string) {
  const seeder = await stub.createSession(RESOURCE, `seed-${threadId}`);
  await seeder.thread.create({ id: threadId });
  await seeder.thread.setSetting({ key: 'agentId', value: AGENT.id });
}

function chatClient(threadId: string, opts: Partial<ConstructorParameters<typeof AgentChatClient>[0]> = {}) {
  return new AgentChatClient({ agentId: 'alice', threadId, resourceId: RESOURCE, fetch: routeFetch, ...opts });
}

const users = (s: AgentChatState) =>
  s.items.filter((i): i is Extract<AgentChatItem, { kind: 'user' }> => i.kind === 'user');
const assistantText = (s: AgentChatState) =>
  s.items
    .filter((i) => i.kind === 'assistant')
    .map((i) => (i as { text: string }).text)
    .join('');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const slowFirstTurn = () => {
  chunkDelayMs = 20;
  script = (call) =>
    call === 1 ? stubText('t1', Array.from({ length: 20 }, (_, i) => `w${i} `)) : stubText('t2', ['second-turn']);
};

describe('AGUI-1b client ↔ POST /api/agui/[agentId]', () => {
  let originalRequire: any;

  before(async () => {
    const Module = require('module');
    originalRequire = Module.prototype.require;
    Module.prototype.require = function (id: string) {
      if (id === '@/lib/chat' || id.endsWith('/lib/chat') || id.endsWith('/lib/chat/index')) {
        return {
          ChatAgentError,
          resolveChatAgent: async (key: string) => {
            if (key === AGENT.id || key === AGENT.urlKey) return AGENT;
            throw new ChatAgentError('Agent not found', 404);
          },
          chatResourceId: (companyId: string) => `company-${companyId}:chat:free`,
          getOrCreateChatController: async () => stub.controller,
          getChatSession: async (
            _c: unknown,
            _a: unknown,
            o: { resourceId: string; scope?: string; threadId?: string; tags?: Record<string, string>; createInitialThread?: boolean },
          ) => {
            // Same arguments as lib/chat/registry.ts getChatSession → controller.createSession.
            if (o.threadId) {
              return stub.controller.createSession({
                resourceId: o.resourceId,
                id: o.threadId,
                ownerId: stub.controller.id,
                tags: o.tags,
                scope: o.scope,
                threadId: o.threadId,
              });
            }
            const key = `${o.resourceId}::${o.scope ?? ''}`;
            if (!sessions.has(key)) {
              sessions.set(
                key,
                o.createInitialThread === false
                  ? await stub.controller.createSession({
                      resourceId: o.resourceId,
                      id: key,
                      ownerId: stub.controller.id,
                      scope: o.scope,
                      createInitialThread: false,
                    })
                  : await stub.createSession(o.resourceId, o.scope),
              );
            }
            return sessions.get(key);
          },
          createChatRequestContext: () => requestContext,
        };
      }
      if (id === '@/lib/company' || id.endsWith('/lib/company')) return { ActiveCompanyError };
      if (id.endsWith('/lib/assistant/thread-store')) {
        return { ASSISTANT_MAX_PINS_PER_AGENT: 50, listPinnedAssistantThreadIds: async () => [] };
      }
      if (id === '@tourbillon/mastra') {
        return {
          runWithHeartbeatContext: async (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
          // OBS-1: tracing off here (trace ids per run are covered in agui-route.test.ts).
          buildAssistantTracingOptions: () => undefined,
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    POST = (await import('./[agentId]/route')).POST as unknown as Handler;
    assistant = await import('../../../lib/assistant/threads');
    Module.prototype.require = originalRequire;
  });

  after(() => {
    require('module').prototype.require = originalRequire;
  });

  beforeEach(async () => {
    chunkDelayMs = 0;
    script = (_call, prompt) =>
      prompt.some((m) => m.role === 'tool') ? stubText('t', ['Hello ', 'there']) : stubToolCall('call-1', 'echo', { text: 'hi' });
    sessions = new Map();
    stub = await createStubAgentController({
      script: (call, prompt) => script(call, prompt),
      get chunkDelayMs() {
        return chunkDelayMs;
      },
      tools: { echo: (i: { text: string }) => ({ echoed: i.text }) },
    } as Parameters<typeof createStubAgentController>[0]);
  });

  it('runs a turn: user message, tool call with result, streamed text, run finished', async () => {
    await seedThread('c-thread-1');
    const client = chatClient('c-thread-1');
    const statuses = new Set<string>();
    client.subscribe(() => statuses.add(client.getState().status));
    assert.equal((await client.send('please echo hi')).ok, true);
    await client.whenIdle();
    const st = client.getState();
    assert.equal(st.error, null, JSON.stringify(st.error));
    assert.equal(st.lastOutcome, 'success');
    assert.deepEqual(st.items.map((i) => i.kind), ['user', 'tool', 'assistant']);
    const tool = st.items[1] as Extract<AgentChatItem, { kind: 'tool' }>;
    assert.equal(tool.name, 'echo');
    assert.deepEqual(JSON.parse(tool.argsText), { text: 'hi' });
    assert.equal(tool.status, 'done');
    assert.match(String(tool.result), /echoed/);
    assert.equal(assistantText(st), 'Hello there');
    assert.equal(users(st)[0].delivery, 'delivered');
    assert.ok(statuses.has('running'));
  });

  for (const action of ['followUp', 'steer'] as const) {
    it(`${action} mid-run: delivered on the open run, which streams the new turn`, async () => {
      slowFirstTurn();
      await seedThread(`c-thread-${action}`);
      let pending: Promise<{ ok: boolean }> | undefined;
      const client = chatClient(`c-thread-${action}`, {
        onRunEvent: (e) => {
          if (e.type === 'TEXT_MESSAGE_CONTENT' && !pending) {
            pending = action === 'followUp' ? client.send('follow-up message') : client.steer('steer message');
          }
        },
      });
      await client.send('start');
      await client.whenIdle();
      assert.equal((await pending!).ok, true);
      const st = client.getState();
      assert.equal(st.error, null, JSON.stringify(st.error));
      assert.equal(st.lastOutcome, 'success');
      assert.deepEqual(users(st).map((u) => [u.mode, u.delivery]), [
        ['run', 'delivered'],
        [action, 'delivered'],
      ]);
      assert.ok(assistantText(st).endsWith('second-turn'), assistantText(st));
      assert.match(JSON.stringify(stub.prompts[1]), new RegExp(`${action === 'followUp' ? 'follow-up' : 'steer'} message`));
    });
  }

  it('abort mid-run: the run ends cancelled; the next message starts a new run', async () => {
    slowFirstTurn();
    await seedThread('c-thread-abort');
    let stopping: Promise<{ ok: boolean }> | undefined;
    const client = chatClient('c-thread-abort', {
      onRunEvent: (e) => {
        if (e.type === 'TEXT_MESSAGE_CONTENT' && !stopping) stopping = client.abort();
      },
    });
    await client.send('start');
    await client.whenIdle();
    assert.equal((await stopping!).ok, true);
    let st = client.getState();
    assert.equal(st.lastOutcome, 'cancelled');
    assert.equal(st.error, null);
    assert.ok(!assistantText(st).includes('w19'), 'stopped before the end');

    chunkDelayMs = 0;
    script = () => stubText('t3', ['fresh']);
    await client.send('next');
    await client.whenIdle();
    st = client.getState();
    assert.equal(st.lastOutcome, 'success');
    assert.ok(assistantText(st).endsWith('fresh'));
  });

  it('dispose mid-run (navigating away) stops the run on the server', async () => {
    // First turn would stream for ~1.2 s; the thread must free up well before that.
    chunkDelayMs = 20;
    script = () => stubText('t1', Array.from({ length: 60 }, (_, i) => `w${i} `));
    await seedThread('c-thread-dispose');
    let disposed = false;
    const first = chatClient('c-thread-dispose', {
      onRunEvent: (e) => {
        if (e.type === 'TEXT_MESSAGE_CONTENT' && !disposed) {
          disposed = true;
          first.dispose();
        }
      },
    });
    await first.send('start');
    // A new client on the same thread can run straight away: the old run is not left going.
    chunkDelayMs = 0;
    script = () => stubText('t4', ['after dispose']);
    const second = chatClient('c-thread-dispose');
    let ok = false;
    const t0 = Date.now();
    for (let i = 0; i < 50 && !ok; i++) {
      await sleep(20);
      if ((await second.send('hello again')).ok) ok = true;
      else second.clearError();
    }
    assert.ok(ok, 'thread became free after dispose');
    assert.ok(Date.now() - t0 < 900, `freed after ${Date.now() - t0} ms, not when the old run would have ended`);
    await second.whenIdle();
    assert.equal(second.getState().lastOutcome, 'success');
    assert.equal(assistantText(second.getState()), 'after dispose');
  });

  it('a second session starting a run on a busy thread gets a 409 conflict', async () => {
    slowFirstTurn();
    await seedThread('c-thread-busy');
    let other: AgentChatClient | undefined;
    let refused: Promise<{ ok: boolean }> | undefined;
    const owner = chatClient('c-thread-busy', {
      onRunEvent: (e) => {
        if (e.type === 'TEXT_MESSAGE_CONTENT' && !refused) {
          other = chatClient('c-thread-busy', { sessionScope: 'other-tab' });
          refused = other.send('me too');
        }
      },
    });
    await owner.send('start');
    await owner.whenIdle();
    assert.equal((await refused!).ok, false);
    const st = other!.getState();
    assert.equal(st.error?.kind, 'conflict');
    assert.equal(st.error?.status, 409);
    assert.ok(st.error?.message, 'shows the endpoint message');
    assert.equal(users(st)[0].delivery, 'failed');
    assert.equal(owner.getState().lastOutcome, 'success');
  });
  describe('a second tab on the same agent', () => {
    const agent = { ...AGENT, status: 'active' };
    /** What the assistant view does on load: list the agent's threads, create one when there are none. */
    async function bootstrap(create: boolean) {
      const session = await assistant.openAssistantSession(agent);
      const threads = await assistant.listAssistantThreads(session, agent, { viewerKey: 'user-1' });
      const created = create ? await assistant.createAssistantThread(session, agent) : null;
      return { threads, created };
    }
    async function firstTabRunning() {
      slowFirstTurn();
      const first = await bootstrap(true);
      const tab1 = chatClient(first.created!.id);
      let streaming!: () => void;
      const textSeen = new Promise<void>((r) => (streaming = r));
      tab1.subscribe(() => {
        if (assistantText(tab1.getState())) streaming();
      });
      assert.equal((await tab1.send('start')).ok, true);
      await textSeen;
      return { tab1, threadId: first.created!.id };
    }
    function assertFinished(tab1: AgentChatClient) {
      const st = tab1.getState();
      assert.equal(st.lastOutcome, 'success');
      assert.equal(st.error, null, JSON.stringify(st.error));
      assert.ok(assistantText(st).includes('w19'), 'streamed to the end');
    }

    it('loading the agent again (thread list + new thread) leaves the first tab running to the end', async () => {
      const { tab1, threadId } = await firstTabRunning();
      const second = await bootstrap(false);
      assert.equal(second.threads[0]?.id, threadId, 'reuses the latest thread');
      const created = await bootstrap(true);
      assert.notEqual(created.created!.id, threadId);
      await sleep(100);
      assert.notEqual(tab1.getState().status, 'idle', 'still running after the second load');
      await tab1.whenIdle();
      assertFinished(tab1);
    });

    it('the second tab sending on its own new thread meanwhile is refused; the first tab finishes', async () => {
      const { tab1 } = await firstTabRunning();
      const second = await bootstrap(true);
      const tab2 = chatClient(second.created!.id);
      const r = await tab2.send('hello from tab 2');
      assert.equal(r.ok, false);
      assert.equal(tab2.getState().error?.status, 409);
      await tab1.whenIdle();
      assertFinished(tab1);
    });

    it('the second tab sending on the same thread meanwhile is refused; the first tab finishes', async () => {
      const { tab1, threadId } = await firstTabRunning();
      const tab2 = chatClient(threadId);
      assert.equal((await tab2.send('me too')).ok, false);
      assert.equal(tab2.getState().error?.status, 409);
      await tab1.whenIdle();
      assertFinished(tab1);
    });
  });
});
