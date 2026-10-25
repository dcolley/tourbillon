/**
 * AGUI-1: POST /api/agui/[agentId] — auth and company scope, run streaming through the official AG-UI
 * client, and run control (abort / steer / follow-up / tool approval).
 *
 * '@/lib/chat' is mocked only at the registry boundary: agent resolution mirrors the chat routes'
 * outcomes (no active company / agent token → ActiveCompanyError, other company's agent → 404), and the
 * controller is a real Mastra AgentController on in-memory storage with a stub model.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { HttpAgent } from '@ag-ui/client';
import type { BaseEvent } from '@ag-ui/core';
import { buildAssistantTracingOptions } from '../../../../../packages/mastra/src/observability/assistant-tracing';
import {
  createCapturingObservability,
  createStubAgentController,
  createStubRequestContext,
  promptText,
  stubText,
  stubToolCall,
  type StubAgentController,
} from '../../../lib/agui/testing/stub-agent-controller';
import { setThreadProviderDepsForTests } from '../../../lib/chat/thread-model';

type Ev = BaseEvent & Record<string, any>;
type Handler = (req: NextRequest, ctx: { params: Promise<{ agentId: string }> }) => Promise<Response>;

const AGENT = { id: 'agent-a', urlKey: 'alice', name: 'Alice', companyId: 'company-a', modelId: 'm', providerId: 'provider-a' };
const DEFAULT_RESOURCE = 'company-company-a:chat:free';
/** Server-pinned AG-UI session scope for agent-a. */
const SCOPE = 'agui:agent-a';
const SESSION_KEY = `${DEFAULT_RESOURCE}::${SCOPE}`;

let authMode: 'ok' | 'no-company' | 'agent-token' = 'ok';
let stub: StubAgentController;
let sessions: Map<string, any>;
const controllerCalls: Array<{ agent: unknown; opts: unknown }> = [];
const sessionCalls: Array<{ resourceId?: string; scope?: string }> = [];
const heartbeatCalls: unknown[] = [];
/** OBS-1: tracing on/off for the route's buildAssistantTracingOptions (the real builder, env check overridden). */
let tracingOn = false;
const tracingCalls: Array<Record<string, unknown>> = [];
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
  opts: {
    query?: string;
    forwardedProps?: unknown;
    onEvent?: (e: Ev, agent: HttpAgent) => void;
    message?: string;
    noSeed?: boolean;
  } = {},
) {
  const events: Ev[] = [];
  let failure: unknown;
  if (!opts.noSeed) {
    const seeder = await stub.createSession(DEFAULT_RESOURCE, 'seed-check');
    if (!(await seeder.thread.getById({ threadId }))) await seedThread(threadId);
  }
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

/** Threads are created through the chat thread API (tagged to the agent); the AG-UI route never creates one. */
async function seedThread(threadId: string, opts: { resourceId?: string; agentId?: string | null } = {}) {
  const seeder = await stub.createSession(opts.resourceId ?? DEFAULT_RESOURCE, `seed-${threadId}`);
  await seeder.thread.create({ id: threadId });
  if (opts.agentId !== null) await seeder.thread.setSetting({ key: 'agentId', value: opts.agentId ?? AGENT.id });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
          buildAssistantTracingOptions: (i: Parameters<typeof buildAssistantTracingOptions>[0]) => {
            tracingCalls.push(i as never);
            return buildAssistantTracingOptions(i, { enabled: tracingOn });
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
    tracingOn = false;
    tracingCalls.length = 0;
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

  describe('assistant switch', () => {
    const saved = process.env.ASSISTANT_ENABLED;
    afterEach(() => {
      if (saved === undefined) delete process.env.ASSISTANT_ENABLED;
      else process.env.ASSISTANT_ENABLED = saved;
    });

    it('ASSISTANT_ENABLED=false → 404 before the agent or any session is touched', async () => {
      process.env.ASSISTANT_ENABLED = 'false';
      const res = await request('alice', input('t1'));
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: 'Not found' });
      assert.equal(controllerCalls.length, 0);
      assert.equal(sessionCalls.length, 0);
    });
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
      assert.deepEqual(sessionCalls, [{ resourceId: DEFAULT_RESOURCE, scope: SCOPE }]);
      assert.deepEqual(heartbeatCalls, [
        { runId: 'chat-agent-a', companyId: 'company-a', agentId: 'agent-a', threadId: 'agui-thread-1' },
      ]);
      // The AG-UI thread is the Mastra memory thread in the company resource, tagged to the agent.
      const session = sessions.get(SESSION_KEY);
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
      const session = sessions.get(SESSION_KEY);
      assert.equal(session.thread.getId(), 'agui-thread-2');
      const stored = JSON.stringify(await session.thread.listMessages({ threadId: 'agui-thread-2' }));
      assert.match(stored, /please echo hi/);
      assert.match(stored, /second message/);
      // The second model call saw the first turn's history from the same Mastra thread.
      assert.match(JSON.stringify(stub.prompts.at(-1)), /please echo hi/);
    });

    it('dashboard context and session scope are honoured', async () => {
      script = () => stubText('t', ['ok']);
      await seedThread('agui-thread-3', { resourceId: 'company-company-a:chat:issue:42' });
      await clientRun('agui-thread-3', {
        noSeed: true,
        forwardedProps: {
          tourbillon: {
            resourceId: 'company-company-a:chat:issue:42',
            sessionScope: 'panel-1',
            context: { contextType: 'issue', contextId: '42', contextTitle: 'Fix it' },
          },
        },
      });
      // The client scope is a sub-scope of the server-pinned agent scope.
      assert.deepEqual(sessionCalls, [{ resourceId: 'company-company-a:chat:issue:42', scope: `${SCOPE}:panel-1` }]);
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
              sessions.get(SESSION_KEY).abort();
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
            sessions.get(SESSION_KEY).subscribe((ev: any) => {
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
        // A follow-up on an open AG-UI run is queued on that run.
        assert.deepEqual(ctl[1].value, action === 'followUp' ? { action, accepted: true, queued: 1 } : { action, accepted: true });
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
      await seedThread('agui-thread-b');
      const res = await request('alice', input('agui-thread-b', { forwardedProps: { tourbillon: { action: 'abort' } } }, ''));
      assert.equal(res.status, 404);
    });

    it('tool approval via forwardedProps and via AG-UI resume entries', async () => {
      await clientRun('agui-thread-approve');
      const session = sessions.get(SESSION_KEY);
      const decisions: unknown[] = [];
      session.respondToToolApproval = (args: { toolCallId: string }) => {
        decisions.push(args);
        return args.toolCallId === 'c1' ? { accepted: true } : { accepted: false, reason: 'not_pending' };
      };
      const a = await readSse(
        await request(
          'alice',
          input('agui-thread-approve', { forwardedProps: { tourbillon: { action: 'toolApproval', toolCallId: 'c1', approved: true } } }, ''),
        ),
      );
      assert.deepEqual(a[1].value, {
        action: 'toolApproval',
        accepted: true,
        toolCallIds: ['c1'],
        results: [{ toolCallId: 'c1', accepted: true }],
      });
      // A dismissal for a call that is neither a pending approval nor a widget call changes nothing
      // (accepted:false / not_pending, as for a decline that races a settled approval).
      const unknown = await readSse(
        await request('alice', input('agui-thread-approve', { resume: [{ interruptId: 'c3', status: 'cancelled' }] }, '')),
      );
      assert.deepEqual(unknown[1].value, {
        action: 'toolApproval',
        accepted: false,
        toolCallIds: ['c3'],
        results: [{ toolCallId: 'c3', accepted: false, reason: 'not_pending' }],
      });
      // A decline for an approval the session lists as pending goes to Mastra (here it has just settled).
      const approval = session.approval as { getToolCallIds: () => string[] };
      const listed = approval.getToolCallIds;
      approval.getToolCallIds = () => ['c2'];
      const b = await readSse(
        await request('alice', input('agui-thread-approve', { resume: [{ interruptId: 'c2', status: 'cancelled' }] }, '')),
      );
      approval.getToolCallIds = listed;
      // The Mastra result is passed through: nothing was pending for c2.
      assert.deepEqual(b[1].value, {
        action: 'toolApproval',
        accepted: false,
        toolCallIds: ['c2'],
        results: [{ toolCallId: 'c2', accepted: false, reason: 'not_pending' }],
      });
      assert.deepEqual(decisions, [
        { toolCallId: 'c1', decision: 'approve', requestContext },
        { toolCallId: 'c2', decision: 'decline', requestContext },
      ]);
    });

    it('tool approval or resume for a thread the session is not on → 404, nothing decided', async () => {
      await clientRun('agui-thread-on');
      await seedThread('agui-thread-off');
      const session = sessions.get(SESSION_KEY);
      assert.equal(session.thread.getId(), 'agui-thread-on');
      const decisions: unknown[] = [];
      session.respondToToolApproval = (args: unknown) => {
        decisions.push(args);
        return { accepted: true };
      };
      const viaProps = await request(
        'alice',
        input('agui-thread-off', { forwardedProps: { tourbillon: { action: 'toolApproval', toolCallId: 'c1', approved: true } } }, ''),
      );
      assert.equal(viaProps.status, 404);
      const viaResume = await request('alice', input('agui-thread-off', { resume: [{ interruptId: 'c1', status: 'resolved' }] }, ''));
      assert.equal(viaResume.status, 404);
      assert.deepEqual(decisions, []);
    });

    it('another session of the same agent cannot approve, resume or control the open run → 409', async () => {
      chunkDelayMs = 20;
      script = () => stubText('t1', Array.from({ length: 30 }, (_, i) => `w${i} `));
      await seedThread('agui-thread-owned');
      // A second AG-UI session (another client sessionScope) bound to the same thread, as when a new
      // session adopts the resource's latest thread.
      const other = await stub.createSession(DEFAULT_RESOURCE, `${SCOPE}:other`);
      await other.thread.switch({ threadId: 'agui-thread-owned' });
      sessions.set(`${DEFAULT_RESOURCE}::${SCOPE}:other`, other);
      const decisions: unknown[] = [];
      other.respondToToolApproval = (args: unknown) => {
        decisions.push(args);
        return { accepted: true };
      };
      let otherAborts = 0;
      const realAbort = other.abort.bind(other);
      other.abort = () => {
        otherAborts++;
        realAbort();
      };
      const realRunId = other.getCurrentRunId.bind(other);
      const fwd = (tourbillon: Record<string, unknown>) => ({ forwardedProps: { tourbillon: { sessionScope: 'other', ...tourbillon } } });
      const attempts: Array<[string, Record<string, unknown>]> = [
        ['toolApproval', fwd({ action: 'toolApproval', toolCallId: 'c1', approved: true })],
        ['resume', { ...fwd({}), resume: [{ interruptId: 'c1', status: 'resolved' }] }],
        ['abort', fwd({ action: 'abort' })],
        ['steer', fwd({ action: 'steer' })],
        ['followUp', fwd({ action: 'followUp' })],
      ];
      let checks: Promise<string[]> | undefined;
      const { events, failure } = await clientRun('agui-thread-owned', {
        onEvent: (e) => {
          if (e.type === 'TEXT_MESSAGE_CONTENT' && !checks) {
            checks = (async () => {
              const out: string[] = [];
              // Also when Mastra reports a run on the other session (e.g. a suspended run it can see
              // from the thread's persisted state): the claim, not the session's run state, decides.
              for (const otherRunning of [false, true]) {
                other.getCurrentRunId = otherRunning ? () => 'owner-run' : realRunId;
                for (const [name, extra] of attempts) {
                  const res = await request('alice', input('agui-thread-owned', extra, 'x'));
                  out.push(`${otherRunning ? 'running' : 'idle'}:${name}:${res.status}`);
                  if (res.status === 200) await readSse(res);
                }
              }
              other.getCurrentRunId = realRunId;
              return out;
            })();
          }
        },
      });
      const results = await checks!;
      assert.deepEqual(
        results,
        ['idle', 'running'].flatMap((state) => attempts.map(([name]) => `${state}:${name}:409`)),
      );
      assert.deepEqual(decisions, []);
      assert.equal(otherAborts, 0);
      assert.equal(failure, undefined);
      assert.equal(events.at(-1)!.type, 'RUN_FINISHED');
      assert.deepEqual(events.at(-1)!.outcome, { type: 'success' });
      assert.equal(text(events), Array.from({ length: 30 }, (_, i) => `w${i} `).join(''));
      assert.equal(stub.modelCalls, 1);
    });
  });

  describe('thread ownership on every request', () => {
    it('a session already on another agent\'s thread cannot run or act on it', async () => {
      await seedThread('bobs-current', { agentId: 'agent-b' });
      // The pinned session for agent-a ends up bound to a thread of agent-b (e.g. it adopted the newest
      // thread of the shared resource when it was created).
      const session = await stub.createSession(DEFAULT_RESOURCE, SCOPE);
      sessions.set(SESSION_KEY, session);
      await session.thread.switch({ threadId: 'bobs-current' });
      assert.equal(session.thread.getId(), 'bobs-current');

      const run = await request('alice', input('bobs-current'));
      assert.equal(run.status, 404);
      for (const action of ['abort', 'steer', 'followUp'] as const) {
        const res = await request('alice', input('bobs-current', { forwardedProps: { tourbillon: { action } } }, 'x'));
        assert.equal(res.status, 404, action);
      }
      const approval = await request(
        'alice',
        input('bobs-current', { forwardedProps: { tourbillon: { action: 'toolApproval', toolCallId: 'c1', approved: true } } }, ''),
      );
      assert.equal(approval.status, 404);
      assert.equal(stub.modelCalls, 0);
    });

    it('an untagged thread in the resource is refused', async () => {
      await seedThread('untagged', { agentId: null });
      assert.equal((await request('alice', input('untagged'))).status, 404);
      assert.equal(stub.modelCalls, 0);
    });

    it('a client sessionScope stays inside the agent\'s pinned scope', async () => {
      await seedThread('scoped', { agentId: 'agent-b' });
      for (const sessionScope of ['agui', 'agui:agent-b', 'x']) {
        sessionCalls.length = 0;
        const res = await request('alice', input('scoped', { forwardedProps: { tourbillon: { sessionScope } } }));
        assert.equal(res.status, 404, sessionScope);
        assert.deepEqual(sessionCalls, [{ resourceId: DEFAULT_RESOURCE, scope: `${SCOPE}:${sessionScope}` }]);
      }
      assert.equal(stub.modelCalls, 0);
    });

    it('an unknown thread id → 404 and no thread is created', async () => {
      const res = await request('alice', input('never-created'));
      assert.equal(res.status, 404);
      const probe = await stub.createSession(DEFAULT_RESOURCE, 'probe');
      assert.equal(await probe.thread.getById({ threadId: 'never-created' }), null);
      assert.equal(stub.modelCalls, 0);
    });
  });

  describe('one run at a time', () => {
    const slowScript = () => {
      chunkDelayMs = 10;
      script = () => stubText('t', Array.from({ length: 10 }, (_, i) => `w${i} `));
    };

    it('parallel runs on the same thread: exactly one is accepted', async () => {
      slowScript();
      await seedThread('race-1');
      const responses = await Promise.all(Array.from({ length: 10 }, () => request('alice', input('race-1'))));
      const statuses = responses.map((r) => r.status).sort();
      assert.deepEqual(statuses, [200, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
      await Promise.all(responses.filter((r) => r.status === 200).map(readSse));
      assert.equal(stub.modelCalls, 1);
    });

    it('parallel runs on the same thread from different session scopes: exactly one is accepted', async () => {
      slowScript();
      await seedThread('race-2');
      const responses = await Promise.all(
        ['p1', 'p2', 'p3', 'p4'].map((sessionScope) =>
          request('alice', input('race-2', { forwardedProps: { tourbillon: { sessionScope } } })),
        ),
      );
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409, 409, 409]);
      await Promise.all(responses.filter((r) => r.status === 200).map(readSse));
      assert.equal(stub.modelCalls, 1);
    });

    it('parallel runs on different threads of one session: exactly one is accepted', async () => {
      slowScript();
      await seedThread('race-3a');
      await seedThread('race-3b');
      const responses = await Promise.all([request('alice', input('race-3a')), request('alice', input('race-3b'))]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
      await Promise.all(responses.filter((r) => r.status === 200).map(readSse));
    });

    it('the claim is released when the stream closes, so the next run is accepted', async () => {
      script = () => stubText('t', ['one']);
      await seedThread('race-4');
      const first = await request('alice', input('race-4'));
      assert.equal(first.status, 200);
      await readSse(first);
      const second = await request('alice', input('race-4'));
      assert.equal(second.status, 200);
      await readSse(second);
    });

    it('client disconnect drops queued follow-ups', async () => {
      chunkDelayMs = 20;
      script = (call) =>
        call === 1 ? stubText('t1', Array.from({ length: 30 }, (_, i) => `w${i} `)) : stubText('t2', ['queued-turn']);
      let queued: Promise<Response> | undefined;
      let disconnected = false;
      await clientRun('agui-thread-drop', {
        onEvent: (e, agent) => {
          if (e.type === 'TEXT_MESSAGE_CONTENT' && !queued) {
            queued = request('alice', input('agui-thread-drop', { forwardedProps: { tourbillon: { action: 'followUp' } } }, 'later'));
            void queued.then(async (r) => {
              assert.equal(r.status, 200);
              await sleep(60);
              disconnected = true;
              agent.abortRun();
            });
          }
        },
      });
      const until = Date.now() + 3000;
      while (!disconnected && Date.now() < until) await sleep(10);
      await sleep(500);
      assert.equal(stub.modelCalls, 1, 'the queued follow-up must not run after the stream closed');
    });

    it("client disconnect also drops a follow-up queued in Mastra's own queue for the thread", async () => {
      chunkDelayMs = 20;
      script = (call) =>
        call === 1 ? stubText('t1', Array.from({ length: 30 }, (_, i) => `w${i} `)) : stubText('t2', ['mastra-queued']);
      let queued = false;
      await clientRun('agui-thread-mastra-q', {
        onEvent: (e, agent) => {
          if (e.type === 'TEXT_MESSAGE_CONTENT' && !queued) {
            queued = true;
            // Queued straight into Mastra (not through the AG-UI claim), as another caller on the thread would.
            void sessions.get(SESSION_KEY).followUp({ content: 'queued in mastra', requestContext });
            setTimeout(() => agent.abortRun(), 60);
          }
        },
      });
      await sleep(500);
      assert.equal(stub.modelCalls, 1, 'the Mastra follow-up must not run after the stream closed');
    });

    it('the claim is released when binding the thread fails, so the next run is accepted', async () => {
      script = () => stubText('t', ['bound']);
      await seedThread('bind-elsewhere');
      await seedThread('bind-fail');
      const session = await stub.createSession(DEFAULT_RESOURCE, SCOPE);
      sessions.set(SESSION_KEY, session);
      await session.thread.switch({ threadId: 'bind-elsewhere' });
      const thread = session.thread;
      const realSwitch = thread.switch;
      thread.switch = async () => {
        throw new Error('switch failed');
      };
      const failed = await request('alice', input('bind-fail'));
      assert.notEqual(failed.status, 200);
      thread.switch = realSwitch;
      // Another session would be refused too if the failed run had kept its thread claim.
      const fromOther = await request('alice', input('bind-fail', { forwardedProps: { tourbillon: { sessionScope: 'later' } } }));
      assert.equal(fromOther.status, 200);
      await readSse(fromOther);
      const next = await request('alice', input('bind-fail'));
      assert.equal(next.status, 200);
      assert.match(text(await readSse(next)), /bound/);
    });

    it('a queued follow-up dropped by abort is reported in the abort response and on the open run', async () => {
      chunkDelayMs = 20;
      script = (call) =>
        call === 1 ? stubText('t1', Array.from({ length: 30 }, (_, i) => `w${i} `)) : stubText('t2', ['queued-turn']);
      let control: Promise<Ev[]> | undefined;
      const { events } = await clientRun('agui-thread-dropped', {
        onEvent: (e) => {
          if (e.type === 'TEXT_MESSAGE_CONTENT' && !control) {
            control = (async () => {
              const q = await readSse(
                await request('alice', input('agui-thread-dropped', { forwardedProps: { tourbillon: { action: 'followUp' } } }, 'later')),
              );
              assert.deepEqual(q[1].value, { action: 'followUp', accepted: true, queued: 1 });
              return readSse(
                await request('alice', input('agui-thread-dropped', { forwardedProps: { tourbillon: { action: 'abort' } } }, '')),
              );
            })();
          }
        },
      });
      const ctl = await control!;
      assert.deepEqual(ctl[1].value, { action: 'abort', accepted: true, droppedFollowUps: 1 });
      const dropped = events.filter((e) => e.type === 'CUSTOM' && e.name === 'tourbillon.follow_up_dropped');
      assert.deepEqual(dropped.map((e) => e.value), [{ count: 1 }]);
      assert.equal(events.at(-2)!.name, 'tourbillon.follow_up_dropped');
      assert.deepEqual(events.at(-1)!.outcome, { type: 'cancelled' });
      await sleep(200);
      assert.equal(stub.modelCalls, 1);
    });
  });

  describe('OBS-1 trace id per run', () => {
    let capture: ReturnType<typeof createCapturingObservability>;
    const savedBase = process.env.PHOENIX_UI_BASE_URL;
    const BASE = 'https://phoenix.example.com';

    beforeEach(async () => {
      tracingOn = true;
      process.env.PHOENIX_UI_BASE_URL = BASE;
      capture = createCapturingObservability();
      stub = await createStubAgentController({
        script: (call, prompt) => script(call, prompt),
        get chunkDelayMs() {
          return chunkDelayMs;
        },
        tools: { echo: (i: { text: string }) => ({ echoed: i.text }) },
        observability: capture.observability,
      } as Parameters<typeof createStubAgentController>[0]);
    });

    after(() => {
      if (savedBase === undefined) delete process.env.PHOENIX_UI_BASE_URL;
      else process.env.PHOENIX_UI_BASE_URL = savedBase;
    });

    const traceEvents = (events: Ev[]) => events.filter((e) => e.type === 'CUSTOM' && e.name === 'tourbillon.trace');

    it('one trace per run: trace event after RUN_STARTED, trace on RUN_FINISHED, spans and saved message carry it', async () => {
      const { events, failure } = await clientRun('obs1-thread-1', { query: '?modelId=provider/model-x' });
      assert.equal(failure, undefined);
      assert.equal(events[0].type, 'RUN_STARTED');
      assert.equal(events[1].type, 'CUSTOM');
      assert.equal(events[1].name, 'tourbillon.trace');
      const traceId = events[1].value.traceId as string;
      assert.match(traceId, /^[0-9a-f]{32}$/);
      assert.deepEqual(events[1].value, { traceId, traceUrl: `${BASE}/redirects/traces/${traceId}` });
      assert.equal(traceEvents(events).length, 1);
      const finished = events.at(-1)!;
      assert.equal(finished.type, 'RUN_FINISHED');
      assert.deepEqual(finished.result, { reason: 'complete', traceId, traceUrl: `${BASE}/redirects/traces/${traceId}` });

      // Trace attributes for this run.
      assert.equal(tracingCalls.length, 1);
      assert.deepEqual(tracingCalls[0], {
        companyId: 'company-a',
        agentId: 'agent-a',
        agentUrlKey: 'alice',
        threadId: 'obs1-thread-1',
        provider: 'provider-a',
        model: 'provider/model-x',
        aguiRunId: finished.runId,
      });

      // The turn's model and tool spans are in that trace; the root carries view=assistant.
      await capture.flush();
      const inTrace = capture.ended.filter((sp) => sp.traceId === traceId);
      const spanTypes = new Set(inTrace.map((sp) => String(sp.type)));
      assert.ok(spanTypes.has('model_generation'), [...spanTypes].join(','));
      assert.ok(spanTypes.has('tool_call'), [...spanTypes].join(','));
      const root = inTrace.find((sp) => sp.isRootSpan)!;
      assert.equal(root.metadata?.view, 'assistant');
      assert.equal(root.metadata?.threadId, 'obs1-thread-1');

      // Saved assistant message carries the trace id (what the thread messages API returns on reload).
      const session = sessions.get(SESSION_KEY);
      const saved = (await session.thread.listMessages({ threadId: 'obs1-thread-1' })) as Array<{ role: string; content: any }>;
      const assistant = saved.filter((m) => m.role === 'assistant');
      assert.ok(assistant.length > 0);
      for (const m of assistant) assert.equal(m.content.metadata?.traceId, traceId);
    });

    it('a new run gets a new trace id', async () => {
      const first = await clientRun('obs1-thread-2');
      const second = await clientRun('obs1-thread-2');
      const a = traceEvents(first.events)[0].value.traceId;
      const b = traceEvents(second.events)[0].value.traceId;
      assert.ok(a && b && a !== b);
    });

    it('no traceUrl when PHOENIX_UI_BASE_URL is unset (trace id still sent)', async () => {
      delete process.env.PHOENIX_UI_BASE_URL;
      const { events } = await clientRun('obs1-thread-3');
      const [trace] = traceEvents(events);
      assert.deepEqual(Object.keys(trace.value), ['traceId']);
      assert.deepEqual(Object.keys(events.at(-1)!.result).sort(), ['reason', 'traceId']);
    });

    it('tracing off: no trace event, no trace on RUN_FINISHED', async () => {
      tracingOn = false;
      const { events } = await clientRun('obs1-thread-4');
      assert.equal(traceEvents(events).length, 0);
      assert.deepEqual(events.at(-1)!.result, { reason: 'complete' });
    });

    it('a follow-up queued on the open run joins the run trace', async () => {
      chunkDelayMs = 40;
      script = (call) => (call === 1 ? stubText('t1', ['a ', 'b ', 'c ']) : stubText('t2', ['second-turn']));
      let control: Promise<Ev[]> | undefined;
      const { events, failure } = await clientRun('obs1-thread-5', {
        onEvent: (e) => {
          if (e.type === 'TEXT_MESSAGE_CONTENT' && !control) {
            control = request(
              'alice',
              input('obs1-thread-5', { forwardedProps: { tourbillon: { action: 'followUp' } } }, 'follow-up message'),
            ).then(readSse);
          }
        },
      });
      assert.equal(failure, undefined);
      const ctl = await control!;
      assert.deepEqual(ctl[1].value, { action: 'followUp', accepted: true, queued: 1 });
      assert.ok(text(events).endsWith('second-turn'));
      const traceId = traceEvents(events)[0].value.traceId;
      assert.equal(tracingCalls.length, 1, 'the control request reuses the open run trace');
      await capture.flush();
      const roots = capture.ended.filter((sp) => sp.isRootSpan);
      assert.ok(roots.length >= 2, `two turns traced (got ${roots.length})`);
      for (const r of roots) assert.equal(r.traceId, traceId);
      const session = sessions.get(SESSION_KEY);
      const saved = (await session.thread.listMessages({ threadId: 'obs1-thread-5' })) as Array<{ role: string; content: any }>;
      const assistant = saved.filter((m) => m.role === 'assistant');
      assert.ok(assistant.length >= 1);
      for (const m of assistant) assert.equal(m.content.metadata?.traceId, traceId);
    });
  });
  describe('CHAT-5 model choice per thread', () => {
    let availability: Record<string, boolean>;
    const providerChecks: Array<[string, string]> = [];

    beforeEach(() => {
      availability = { 'provider-b': true };
      providerChecks.length = 0;
      setThreadProviderDepsForTests({
        isProviderAvailable: async (companyId, providerId) => {
          providerChecks.push([companyId, providerId]);
          return availability[providerId] ?? false;
        },
      });
    });
    afterEach(() => setThreadProviderDepsForTests(null));

    async function seedWithChoice(threadId: string, choice: Record<string, unknown>) {
      await seedThread(threadId);
      const seeder = await stub.createSession(DEFAULT_RESOURCE, `seed-${threadId}`);
      await seeder.thread.switch({ threadId });
      await seeder.thread.setSetting({ key: 'assistantModel', value: choice as never });
    }

    it("runs on the thread's provider, model and effort (over ?modelId=), with trace attributes", async () => {
      await seedWithChoice('chat5-thread-1', { providerId: 'provider-b', modelId: 'other/model', reasoningLevel: 'high' });
      const { events, failure } = await clientRun('chat5-thread-1', { query: '?modelId=provider/model-x' });
      assert.equal(failure, undefined, JSON.stringify(events.find((e) => e.type === 'RUN_ERROR')));
      assert.equal(events.at(-1)!.type, 'RUN_FINISHED');
      assert.deepEqual(providerChecks, [['company-a', 'provider-b']], 're-checked against the agent company');
      assert.deepEqual(controllerCalls.at(-1)!.opts, {
        modelIdOverride: 'other/model',
        providerIdOverride: 'provider-b',
        reasoningLevelOverride: 'high',
      });
      assert.equal(tracingCalls.length, 1);
      assert.equal(tracingCalls[0].provider, 'provider-b');
      assert.equal(tracingCalls[0].model, 'other/model');
      assert.equal(tracingCalls[0].modelSource, 'thread');
      assert.equal(tracingCalls[0].reasoningLevel, 'high');
    });

    it('a provider that is off or gone → 409 provider_disabled_for_company, no thread controller, no model call', async () => {
      availability = { 'provider-b': false };
      await seedWithChoice('chat5-thread-2', { providerId: 'provider-b', modelId: 'other/model' });
      const res = await request('alice', input('chat5-thread-2'));
      assert.equal(res.status, 409);
      const body = await res.json();
      assert.equal(body.code, 'provider_disabled_for_company');
      assert.doesNotMatch(JSON.stringify(body), /provider-b|other\/model/);
      assert.equal(controllerCalls.length, 1, 'only the lookup controller');
      assert.deepEqual(controllerCalls[0].opts, { modelIdOverride: undefined });
      assert.equal(stub.modelCalls, 0);

      for (const action of ['steer', 'followUp']) {
        const r = await request('alice', input('chat5-thread-2', { forwardedProps: { tourbillon: { action } } }));
        assert.equal(r.status, 409, action);
      }
      // Abort stays possible.
      const abort = await request('alice', input('chat5-thread-2', { forwardedProps: { tourbillon: { action: 'abort' } } }));
      assert.equal(abort.status, 200);
      assert.equal(stub.modelCalls, 0);
    });

    it("another thread without a choice keeps the agent's model", async () => {
      await seedWithChoice('chat5-thread-3', { providerId: 'provider-b', modelId: 'other/model' });
      const { failure } = await clientRun('chat5-thread-4');
      assert.equal(failure, undefined);
      assert.equal(controllerCalls.length, 1);
      assert.deepEqual(controllerCalls[0].opts, { modelIdOverride: undefined });
      assert.equal(providerChecks.length, 0);
      assert.equal(tracingCalls[0].provider, 'provider-a');
      assert.equal(tracingCalls[0].model, 'm');
      assert.equal('modelSource' in tracingCalls[0], false);
    });

    it('an invalid stored choice is ignored (agent default)', async () => {
      await seedWithChoice('chat5-thread-5', { providerId: 'provider-b', modelId: 'bad model id' });
      const { failure } = await clientRun('chat5-thread-5');
      assert.equal(failure, undefined);
      assert.equal(controllerCalls.length, 1);
      assert.equal(providerChecks.length, 0);
    });
  });
});
