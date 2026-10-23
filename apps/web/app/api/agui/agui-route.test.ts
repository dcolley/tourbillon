/**
 * AGUI-1: POST /api/agui/[agentId] — auth and company scope, run streaming through the official AG-UI
 * client, and run control (abort / steer / follow-up / tool approval).
 *
 * '@/lib/chat' is mocked only at the registry boundary: agent resolution mirrors the chat routes'
 * outcomes (no active company / agent token → ActiveCompanyError, other company's agent → 404), and the
 * controller is a real Mastra AgentController on in-memory storage with a stub model.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { HttpAgent } from '@ag-ui/client';
import type { BaseEvent } from '@ag-ui/core';
import {
  createStubAgentController,
  createStubRequestContext,
  promptText,
  stubText,
  stubToolCall,
  type StubAgentController,
} from '../../../lib/agui/testing/stub-agent-controller';

type Ev = BaseEvent & Record<string, any>;
type Handler = (req: NextRequest, ctx: { params: Promise<{ agentId: string }> }) => Promise<Response>;

const AGENT = { id: 'agent-a', urlKey: 'alice', name: 'Alice', companyId: 'company-a', modelId: 'm' };
const DEFAULT_RESOURCE = 'company-company-a:chat:free';

let authMode: 'ok' | 'no-company' | 'agent-token' = 'ok';
let stub: StubAgentController;
let sessions: Map<string, any>;
const controllerCalls: Array<{ agent: unknown; opts: unknown }> = [];
const sessionCalls: Array<{ resourceId?: string; scope?: string }> = [];
const heartbeatCalls: unknown[] = [];
let POST: Handler;
const requestContext = createStubRequestContext({ chatRequestContext: true });

class ChatAgentError extends Error {
  constructor(message: string, readonly status = 404) {
    super(message);
  }
}
class ActiveCompanyError extends Error {}

function request(agentKey: string, body: unknown, opts: { query?: string; signal?: AbortSignal } = {}) {
  return POST(
    new NextRequest(`http://localhost/api/agui/${agentKey}${opts.query ?? ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    }),
    { params: Promise.resolve({ agentId: agentKey }) },
  );
}

function input(threadId: string, extra: Record<string, unknown> = {}, message = 'hello') {
  return {
    threadId,
    runId: `run-${Math.random().toString(36).slice(2)}`,
    messages: [{ id: 'u1', role: 'user', content: message }],
    tools: [],
    context: [],
    ...extra,
  };
}

async function readSse(res: Response): Promise<Ev[]> {
  const raw = await res.text();
  return raw
    .split('\n\n')
    .map((block) => block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join(''))
    .filter(Boolean)
    .map((json) => JSON.parse(json) as Ev);
}

/** Runs a turn with the official client against the route. */
async function clientRun(
  threadId: string,
  opts: { query?: string; forwardedProps?: unknown; onEvent?: (e: Ev, agent: HttpAgent) => void; message?: string } = {},
) {
  const events: Ev[] = [];
  let failure: unknown;
  const agent = new HttpAgent({
    url: `http://localhost/api/agui/alice${opts.query ?? ''}`,
    threadId,
    initialMessages: [{ id: 'u1', role: 'user', content: opts.message ?? 'please echo hi' }],
    fetch: async (url, init) =>
      POST(
        new NextRequest(url, {
          method: 'POST',
          body: init.body as string,
          headers: init.headers as HeadersInit,
          ...(init.signal ? { signal: init.signal } : {}),
        }),
        { params: Promise.resolve({ agentId: 'alice' }) },
      ),
  });
  await agent
    .runAgent(
      { forwardedProps: opts.forwardedProps },
      {
        onEvent: ({ event }) => {
          events.push(event as Ev);
          opts.onEvent?.(event as Ev, agent);
        },
        onRunFailed: ({ error }) => {
          failure = error;
        },
      },
    )
    .catch((err: unknown) => {
      failure = failure ?? err;
    });
  return { events, failure };
}

const types = (events: Ev[]) => events.map((e) => e.type);
const text = (events: Ev[]) =>
  events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta as string).join('');

let script: Parameters<typeof createStubAgentController>[0]['script'];
let chunkDelayMs = 0;

describe('AGUI-1 POST /api/agui/[agentId]', () => {
  let originalRequire: any;

  before(async () => {
    const Module = require('module');
    originalRequire = Module.prototype.require;
    Module.prototype.require = function (id: string) {
      if (id === '@/lib/chat' || id.endsWith('/lib/chat') || id.endsWith('/lib/chat/index')) {
        return {
          ChatAgentError,
          resolveChatAgent: async (key: string) => {
            if (authMode === 'no-company') throw new ActiveCompanyError('No active company selected');
            if (authMode === 'agent-token') throw new ActiveCompanyError('Agent tokens cannot use board chat');
            if (key === AGENT.id || key === AGENT.urlKey) return AGENT;
            throw new ChatAgentError('Agent not found', 404);
          },
          chatResourceId: (companyId: string) => `company-${companyId}:chat:free`,
          getOrCreateChatController: async (agent: unknown, opts: unknown) => {
            controllerCalls.push({ agent, opts });
            return stub.controller;
          },
          getChatSession: async (_c: unknown, _a: unknown, opts: { resourceId: string; scope?: string }) => {
            sessionCalls.push(opts);
            const key = `${opts.resourceId}::${opts.scope ?? ''}`;
            if (!sessions.has(key)) sessions.set(key, await stub.createSession(opts.resourceId, opts.scope));
            return sessions.get(key);
          },
          createChatRequestContext: () => requestContext,
        };
      }
      if (id === '@/lib/company' || id.endsWith('/lib/company')) return { ActiveCompanyError };
      if (id === '@tourbillon/mastra') {
        return {
          runWithHeartbeatContext: async (ctx: unknown, fn: () => Promise<unknown>) => {
            heartbeatCalls.push(ctx);
            return fn();
          },
        };
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
    authMode = 'ok';
    controllerCalls.length = 0;
    sessionCalls.length = 0;
    heartbeatCalls.length = 0;
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

  describe('auth and company scope (parity with /api/chat/*)', () => {
    it('no board session / active company → 400, nothing started', async () => {
      authMode = 'no-company';
      const res = await request('alice', input('t1'));
      assert.equal(res.status, 400);
      assert.equal(controllerCalls.length, 0);
    });

    it('agent-token caller → refused (400, as the chat routes), nothing started', async () => {
      authMode = 'agent-token';
      const res = await request('alice', input('t1'));
      assert.equal(res.status, 400);
      assert.equal(controllerCalls.length, 0);
    });

    it("another company's agent → 404", async () => {
      const res = await request('agent-of-company-b', input('t1'));
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: 'Agent not found' });
      assert.equal(controllerCalls.length, 0);
    });

    it("a resourceId outside the agent's company → 404 before any session is opened", async () => {
      for (const resourceId of ['company-company-b:chat:free', 'company-company-a', 'anything']) {
        const res = await request('alice', input('t1', { forwardedProps: { tourbillon: { resourceId } } }));
        assert.equal(res.status, 404, resourceId);
      }
      assert.equal(controllerCalls.length, 0);
      assert.equal(sessionCalls.length, 0);
    });

    it("a thread of another resource or another agent → 404", async () => {
      const other = await stub.createSession('company-company-a:chat:issue:9', 'x');
      await other.thread.create({ id: 'foreign-thread' });
      const res1 = await request('alice', input('foreign-thread'));
      assert.equal(res1.status, 404);

      const same = await stub.createSession(DEFAULT_RESOURCE, 'y');
      await same.thread.create({ id: 'bobs-thread' });
      await same.thread.setSetting({ key: 'agentId', value: 'agent-b' });
      const res2 = await request('alice', input('bobs-thread'));
      assert.equal(res2.status, 404);
      assert.equal(stub.modelCalls, 0);
    });

    it('invalid input → 400', async () => {
      assert.equal((await request('alice', '{not json')).status, 400);
      assert.equal((await request('alice', { threadId: 't1', messages: [] })).status, 400);
      assert.equal((await request('alice', input('bad thread id'))).status, 400);
      assert.equal((await request('alice', input('t1', {}, '   '))).status, 400);
      assert.equal(
        (await request('alice', input('t1', { forwardedProps: { tourbillon: { unknownOption: 1 } } }))).status,
        400,
      );
      assert.equal(stub.modelCalls, 0);
    });
  });

  describe('run', () => {
    it('streams text + one tool call to the AG-UI client on the same chat machinery', async () => {
      const { events, failure } = await clientRun('agui-thread-1', { query: '?modelId=provider/model-x' });
      assert.equal(failure, undefined, JSON.stringify(events.find((e) => e.type === 'RUN_ERROR')));
      assert.deepEqual(types(events), [
        'RUN_STARTED',
        'TOOL_CALL_START',
        'TOOL_CALL_ARGS',
        'TOOL_CALL_END',
        'TOOL_CALL_RESULT',
        'TEXT_MESSAGE_START',
        'TEXT_MESSAGE_CONTENT',
        'TEXT_MESSAGE_CONTENT',
        'TEXT_MESSAGE_END',
        'RUN_FINISHED',
      ]);
      assert.equal(events[1].toolCallName, 'echo');
      assert.equal(text(events), 'Hello there');
      // Same controller path as the chat routes (assembled agent, tools, instructions, model override).
      assert.equal(controllerCalls.length, 1);
      assert.equal(controllerCalls[0].agent, AGENT);
      assert.deepEqual(controllerCalls[0].opts, { modelIdOverride: 'provider/model-x' });
      assert.deepEqual(sessionCalls, [{ resourceId: DEFAULT_RESOURCE, scope: 'agui' }]);
      assert.deepEqual(heartbeatCalls, [
        { runId: 'chat-agent-a', companyId: 'company-a', agentId: 'agent-a', threadId: 'agui-thread-1' },
      ]);
      // The AG-UI thread is the Mastra memory thread in the company resource, tagged to the agent.
      const session = sessions.get(`${DEFAULT_RESOURCE}::agui`);
      assert.equal(session.thread.getId(), 'agui-thread-1');
      const thread = await session.thread.getById({ threadId: 'agui-thread-1' });
      assert.equal(thread.resourceId, DEFAULT_RESOURCE);
      assert.equal(thread.metadata.agentId, 'agent-a');
      assert.match(promptText(stub.prompts[0].at(-1)), /please echo hi/);
    });

    it('resumes an existing thread of the same resource and agent', async () => {
      await clientRun('agui-thread-2');
      script = () => stubText('t', ['again']);
      const { events } = await clientRun('agui-thread-2', { message: 'second message' });
      assert.equal(text(events), 'again');
      const session = sessions.get(`${DEFAULT_RESOURCE}::agui`);
      assert.equal(session.thread.getId(), 'agui-thread-2');
      const stored = JSON.stringify(await session.thread.listMessages({ threadId: 'agui-thread-2' }));
      assert.match(stored, /please echo hi/);
      assert.match(stored, /second message/);
      // The second model call saw the first turn's history from the same Mastra thread.
      assert.match(JSON.stringify(stub.prompts.at(-1)), /please echo hi/);
    });

    it('dashboard context and session scope are honoured', async () => {
      script = () => stubText('t', ['ok']);
      await clientRun('agui-thread-3', {
        forwardedProps: {
          tourbillon: {
            resourceId: 'company-company-a:chat:issue:42',
            sessionScope: 'panel-1',
            context: { contextType: 'issue', contextId: '42', contextTitle: 'Fix it' },
          },
        },
      });
      assert.deepEqual(sessionCalls, [{ resourceId: 'company-company-a:chat:issue:42', scope: 'panel-1' }]);
      assert.match(promptText(stub.prompts[0].at(-1)), /\[Dashboard context\]/);
    });

    it('a second run while one is in progress → 409', async () => {
      script = () => stubText('t', Array.from({ length: 30 }, (_, i) => `w${i} `));
      chunkDelayMs = 20;
      let status = 0;
      await clientRun('agui-thread-4', {
        onEvent: (e) => {
          if (e.type === 'TEXT_MESSAGE_CONTENT' && !status) {
            status = -1;
            void request('alice', input('agui-thread-4')).then((r) => {
              status = r.status;
              sessions.get(`${DEFAULT_RESOURCE}::agui`).abort();
            });
          }
        },
      });
      assert.equal(status, 409);
    });

    it('client disconnect (abortRun) aborts the session run', async () => {
      script = () => stubText('t', Array.from({ length: 30 }, (_, i) => `w${i} `));
      chunkDelayMs = 20;
      const ends: string[] = [];
      let aborted = false;
      await clientRun('agui-thread-5', {
        onEvent: (e, agent) => {
          if (e.type === 'RUN_STARTED') {
            sessions.get(`${DEFAULT_RESOURCE}::agui`).subscribe((ev: any) => {
              if (ev.type === 'agent_end') ends.push(ev.reason);
            });
          }
          if (e.type === 'TEXT_MESSAGE_CONTENT' && !aborted) {
            aborted = true;
            agent.abortRun();
          }
        },
      });
      const until = Date.now() + 3000;
      while (ends.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(ends, ['aborted']);
    });
  });

  describe('run control', () => {
    const slow = () => {
      chunkDelayMs = 20;
      script = (call) =>
        call === 1 ? stubText('t1', Array.from({ length: 30 }, (_, i) => `w${i} `)) : stubText('t2', ['second-turn']);
    };

    for (const action of ['steer', 'followUp'] as const) {
      it(`${action} mid-run: control run is accepted and the open run streams the new turn`, async () => {
        slow();
        if (action === 'followUp') {
          script = (call) => (call === 1 ? stubText('t1', ['a ', 'b ', 'c ']) : stubText('t2', ['second-turn']));
          chunkDelayMs = 40;
        }
        let control: Promise<Ev[]> | undefined;
        const { events, failure } = await clientRun('agui-thread-ctl', {
          onEvent: (e) => {
            if (e.type === 'TEXT_MESSAGE_CONTENT' && !control) {
              control = request(
                'alice',
                input('agui-thread-ctl', { forwardedProps: { tourbillon: { action } } }, `${action} message`),
              ).then(readSse);
            }
          },
        });
        assert.equal(failure, undefined);
        const ctl = await control!;
        assert.deepEqual(types(ctl), ['RUN_STARTED', 'CUSTOM', 'RUN_FINISHED']);
        assert.deepEqual(ctl[1].value, { action, accepted: true });
        assert.equal(types(events).filter((t) => t === 'RUN_FINISHED').length, 1);
        assert.ok(text(events).endsWith('second-turn'), text(events));
        assert.match(JSON.stringify(stub.prompts[1]), new RegExp(`${action} message`));
      });
    }

    it('abort mid-run: control accepted, open run finishes as cancelled; idle abort is not accepted', async () => {
      slow();
      let control: Promise<Ev[]> | undefined;
      const { events } = await clientRun('agui-thread-abort', {
        onEvent: (e) => {
          if (e.type === 'TEXT_MESSAGE_CONTENT' && !control) {
            control = request('alice', input('agui-thread-abort', { forwardedProps: { tourbillon: { action: 'abort' } } }, '')).then(readSse);
          }
        },
      });
      const ctl = await control!;
      assert.deepEqual(ctl[1].value, { action: 'abort', accepted: true });
      assert.deepEqual(events.at(-1)!.outcome, { type: 'cancelled' });
      const idle = await readSse(
        await request('alice', input('agui-thread-abort', { forwardedProps: { tourbillon: { action: 'abort' } } }, '')),
      );
      assert.deepEqual(idle[1].value, { action: 'abort', accepted: false });
    });

    it('control for a thread the session is not on → 404', async () => {
      await clientRun('agui-thread-a');
      const res = await request('alice', input('agui-thread-b', { forwardedProps: { tourbillon: { action: 'abort' } } }, ''));
      assert.equal(res.status, 404);
    });

    it('tool approval via forwardedProps and via AG-UI resume entries', async () => {
      await clientRun('agui-thread-approve');
      const session = sessions.get(`${DEFAULT_RESOURCE}::agui`);
      const decisions: unknown[] = [];
      session.respondToToolApproval = async (args: unknown) => {
        decisions.push(args);
      };
      const a = await readSse(
        await request(
          'alice',
          input('agui-thread-approve', { forwardedProps: { tourbillon: { action: 'toolApproval', toolCallId: 'c1', approved: true } } }, ''),
        ),
      );
      assert.deepEqual(a[1].value, { action: 'toolApproval', accepted: true, toolCallIds: ['c1'] });
      const b = await readSse(
        await request('alice', input('agui-thread-approve', { resume: [{ interruptId: 'c2', status: 'cancelled' }] }, '')),
      );
      assert.deepEqual(b[1].value, { action: 'toolApproval', accepted: true, toolCallIds: ['c2'] });
      assert.deepEqual(decisions, [
        { toolCallId: 'c1', decision: 'approve', requestContext },
        { toolCallId: 'c2', decision: 'decline', requestContext },
      ]);
    });
  });
});
