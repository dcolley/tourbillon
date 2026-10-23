/**
 * AGUI-1b: the assistant-view client (lib/agui/client) end to end against the real
 * POST /api/agui/[agentId] route: a turn with text + a tool call, follow-up / steer / abort mid-run,
 * disconnect (dispose) stopping the run, and a run refused with 409.
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
          getChatSession: async (_c: unknown, _a: unknown, o: { resourceId: string; scope?: string }) => {
            const key = `${o.resourceId}::${o.scope ?? ''}`;
            if (!sessions.has(key)) sessions.set(key, await stub.createSession(o.resourceId, o.scope));
            return sessions.get(key);
          },
          createChatRequestContext: () => requestContext,
        };
      }
      if (id === '@/lib/company' || id.endsWith('/lib/company')) return { ActiveCompanyError };
      if (id === '@tourbillon/mastra') {
        return { runWithHeartbeatContext: async (_ctx: unknown, fn: () => Promise<unknown>) => fn() };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    POST = (await import('./[agentId]/route')).POST as unknown as Handler;
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
});
