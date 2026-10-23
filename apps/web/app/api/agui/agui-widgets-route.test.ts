/**
 * WID-1: widgets over the AG-UI endpoint, end to end — a declared widget tool call reaches the
 * official AG-UI client as tool-call events plus an interrupt, the user's answer comes back as an
 * AG-UI `resume` entry, is validated against the server spec, resumes the suspended tool, reaches the
 * model as the tool result and is stored in the thread.
 *
 * Same harness as agui-route.test.ts: '@/lib/chat' is mocked at the registry boundary; the controller
 * is a real Mastra AgentController (in-memory storage, stub model) with the chat controller's
 * request-scoped tool resolver. The widget specs module is replaced by test specs.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { HttpAgent } from '@ag-ui/client';
import type { BaseEvent } from '@ag-ui/core';
import { z } from 'zod';
import { createWidgetSpecIndex, type WidgetSpec } from '@tourbillon/shared/widgets';
import { requestScopedTools } from '@tourbillon/mastra/widget-tools';
import {
  createStubAgentController,
  createStubRequestContext,
  stubText,
  stubToolCall,
  type StubAgentController,
} from '../../../lib/agui/testing/stub-agent-controller';
import { listWidgetAnswers } from '../../../lib/agui/widgets';

type Ev = BaseEvent & Record<string, any>;
type Handler = (req: NextRequest, ctx: { params: Promise<{ agentId: string }> }) => Promise<Response>;

const AGENT = { id: 'agent-a', urlKey: 'alice', name: 'Alice', companyId: 'company-a', modelId: 'm' };
const RESOURCE = 'company-company-a:chat:free';
const SCOPE = 'agui:agent-a';
const SESSION_KEY = `${RESOURCE}::${SCOPE}`;

const picker: WidgetSpec = {
  name: 'testPicker',
  version: 1,
  description: 'Server description: ask the user to pick one option.',
  propsSchema: z.strictObject({ question: z.string().min(1).max(200), options: z.array(z.string().max(100)).min(2).max(10) }),
  answerSchema: z.strictObject({ choice: z.string() }),
  frontendTool: true,
};
const internal: WidgetSpec = {
  name: 'internalNote',
  version: 1,
  description: 'Not a frontend tool.',
  propsSchema: z.strictObject({ text: z.string() }),
};
const specIndex = createWidgetSpecIndex([picker, internal]);

const WIDGET_CALL = 'w-1';
const PICKER_ARGS = { question: 'Ship today?', options: ['Yes', 'No'] };
const DECLARED = [{ name: 'testPicker', description: 'client text is ignored', parameters: { type: 'object' } }];

let stub: StubAgentController;
let sessions: Map<string, any>;
let POST: Handler;

class ChatAgentError extends Error {
  constructor(message: string, readonly status = 404) {
    super(message);
  }
}
class ActiveCompanyError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const types = (events: Ev[]): string[] => events.map((e) => String(e.type));
const text = (events: Ev[]) =>
  events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta as string).join('');

async function readSse(res: Response): Promise<Ev[]> {
  const raw = await res.text();
  return raw
    .split('\n\n')
    .map((block) => block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join(''))
    .filter(Boolean)
    .map((json) => JSON.parse(json) as Ev);
}

function post(body: unknown, signal?: AbortSignal) {
  return POST(
    new NextRequest('http://localhost/api/agui/alice', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    }),
    { params: Promise.resolve({ agentId: 'alice' }) },
  );
}

function resumeBody(threadId: string, resume: unknown[], extra: Record<string, unknown> = {}) {
  return { threadId, runId: `run-${Math.random().toString(36).slice(2)}`, messages: [], tools: [], context: [], resume, ...extra };
}

async function seedThread(threadId: string) {
  const seeder = await stub.createSession(RESOURCE, `seed-${threadId}`);
  await seeder.thread.create({ id: threadId });
  await seeder.thread.setSetting({ key: 'agentId', value: AGENT.id });
}

function client(threadId: string) {
  return new HttpAgent({
    url: 'http://localhost/api/agui/alice',
    threadId,
    initialMessages: [{ id: 'u1', role: 'user', content: 'ask me something' }],
    fetch: async (url, init) =>
      POST(
        new NextRequest(url, { method: 'POST', body: init.body as string, headers: init.headers as HeadersInit }),
        { params: Promise.resolve({ agentId: 'alice' }) },
      ),
  });
}

async function run(agent: HttpAgent, params: Parameters<HttpAgent['runAgent']>[0]) {
  const events: Ev[] = [];
  let failure: unknown;
  await agent
    .runAgent(params, {
      onEvent: ({ event }) => {
        events.push(event as Ev);
      },
      onRunFailed: ({ error }) => {
        failure = error;
      },
    })
    .catch((err: unknown) => {
      failure = failure ?? err;
    });
  return { events, failure };
}

/** First run: the model calls the widget; the run ends with an interrupt. */
async function askWidget(threadId: string) {
  await seedThread(threadId);
  const agent = client(threadId);
  const first = await run(agent, { tools: DECLARED });
  // Let the stream's settle window pass so the run claim is released.
  await sleep(300);
  return { agent, first };
}

/** Latest prompt's tool-result text (what the model saw for the widget call). */
function toolResultInPrompt(prompt: Array<{ role: string; content: unknown }> | undefined): string {
  const tool = prompt?.filter((m) => m.role === 'tool').at(-1);
  return JSON.stringify(tool?.content ?? null);
}

describe('WID-1 widgets over AG-UI (round trip)', () => {
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
          getChatSession: async (_c: unknown, _a: unknown, opts: { resourceId: string; scope?: string }) => {
            const key = `${opts.resourceId}::${opts.scope ?? ''}`;
            if (!sessions.has(key)) sessions.set(key, await stub.createSession(opts.resourceId, opts.scope));
            return sessions.get(key);
          },
          // A fresh request context per request, as in production.
          createChatRequestContext: () => createStubRequestContext({ chatRequestContext: true }),
        };
      }
      if (id === '@/lib/company' || id.endsWith('/lib/company')) return { ActiveCompanyError };
      if (id === '@tourbillon/mastra') {
        return { runWithHeartbeatContext: async (_ctx: unknown, fn: () => Promise<unknown>) => fn() };
      }
      if (id.endsWith('/components/assistant/widgets/specs')) {
        return { assistantWidgetSpecs: [picker, internal], assistantWidgetSpecIndex: specIndex };
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
    sessions = new Map();
    stub = await createStubAgentController({
      script: (_call, prompt) =>
        prompt.some((m) => m.role === 'tool')
          ? stubText('t', ['Thanks, noted.'])
          : stubToolCall(WIDGET_CALL, 'testPicker', PICKER_ARGS),
      controllerTools: requestScopedTools as never,
    });
  });

  it('a declared widget is offered with the server spec; undeclared, unknown and non-frontend ones are not', async () => {
    await seedThread('wt-offer');
    const agent = client('wt-offer');
    await run(agent, {
      tools: [...DECLARED, { name: 'internalNote', description: 'x', parameters: {} }, { name: 'unknownWidget', description: 'x', parameters: {} }],
    });
    const offered = stub.offeredTools[0];
    const widget = offered.find((t) => t.name === 'testPicker');
    assert.ok(widget, JSON.stringify(offered.map((t) => t.name)));
    assert.equal(widget!.description, picker.description);
    assert.ok(!offered.some((t) => t.name === 'internalNote' || t.name === 'unknownWidget'));

    // Not declared → not offered (the REST chat routes never set request-scoped tools either).
    await sleep(300);
    const before = stub.offeredTools.length;
    stub = await createStubAgentController({ script: () => stubText('t', ['ok']), controllerTools: requestScopedTools as never });
    sessions = new Map();
    await seedThread('wt-offer-2');
    await run(client('wt-offer-2'), { tools: [] });
    assert.ok(before > 0);
    assert.ok(!stub.offeredTools[0].some((t) => t.name === 'testPicker'));
  });

  it('the widget call reaches the client as AG-UI tool calls and a tool_suspended interrupt', async () => {
    const { first } = await askWidget('wt-call');
    assert.equal(first.failure, undefined, JSON.stringify(first.events.find((e) => e.type === 'RUN_ERROR')));
    const t = types(first.events);
    assert.deepEqual(t.filter((x) => x.startsWith('TOOL_CALL')), ['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END']);
    const start = first.events.find((e) => e.type === 'TOOL_CALL_START')!;
    assert.equal(start.toolCallId, WIDGET_CALL);
    assert.equal(start.toolCallName, 'testPicker');
    const args = first.events.filter((e) => e.type === 'TOOL_CALL_ARGS').map((e) => e.delta).join('');
    assert.deepEqual(JSON.parse(args), PICKER_ARGS);
    const custom = first.events.find((e) => e.type === 'CUSTOM' && e.name === 'tourbillon.tool_suspended');
    assert.equal(custom?.value.toolCallId, WIDGET_CALL);
    const finished = first.events.at(-1)!;
    assert.equal(finished.type, 'RUN_FINISHED');
    assert.deepEqual(finished.outcome, {
      type: 'interrupt',
      interrupts: [{ id: WIDGET_CALL, reason: 'tool_suspended', toolCallId: WIDGET_CALL }],
    });
    assert.ok(!t.includes('TOOL_CALL_RESULT'));
    assert.equal(stub.modelCalls, 1);
    assert.ok(sessions.get(SESSION_KEY).suspensions.has({ toolCallId: WIDGET_CALL }));
  });

  it('the answer comes back via AG-UI resume, reaches the model as the tool result and is stored in the thread', async () => {
    const { agent } = await askWidget('wt-answer');
    const second = await run(agent, {
      resume: [{ interruptId: WIDGET_CALL, status: 'resolved', payload: { answer: { choice: 'No' } } }],
    });
    assert.equal(second.failure, undefined, JSON.stringify(second.events.find((e) => e.type === 'RUN_ERROR')));
    // Only the result for the already-announced call, then the model's next turn.
    assert.deepEqual(types(second.events).filter((x) => x.startsWith('TOOL_CALL')), ['TOOL_CALL_RESULT']);
    const result = second.events.find((e) => e.type === 'TOOL_CALL_RESULT')!;
    assert.equal(result.toolCallId, WIDGET_CALL);
    assert.deepEqual(JSON.parse(result.content), { widget: 'testPicker', version: 1, answer: { choice: 'No' } });
    assert.equal(text(second.events), 'Thanks, noted.');
    assert.deepEqual(second.events.at(-1)!.outcome, { type: 'success' });

    assert.equal(stub.modelCalls, 2);
    assert.match(toolResultInPrompt(stub.prompts[1]), /testPicker/);
    assert.match(toolResultInPrompt(stub.prompts[1]), /No/);

    const session = sessions.get(SESSION_KEY);
    assert.equal(session.suspensions.has({ toolCallId: WIDGET_CALL }), false);
    const stored = await listWidgetAnswers(specIndex, session, 'wt-answer');
    assert.equal(stored.length, 1);
    assert.deepEqual(
      { ...stored[0], answeredAt: undefined },
      { toolCallId: WIDGET_CALL, widget: 'testPicker', version: 1, answer: { choice: 'No' }, answeredAt: undefined },
    );
    assert.match(stored[0].answeredAt ?? '', /^\d{4}-\d\d-\d\dT/);
  });

  it('invalid answers are refused with 400 and the widget stays open; a valid answer then completes it', async () => {
    await askWidget('wt-invalid');
    const cases: Array<[string, unknown]> = [
      ['unknown answer field', { status: 'resolved', payload: { answer: { choice: 'No', extra: 'secret-x' } } }],
      ['wrong type', { status: 'resolved', payload: { answer: { choice: 7 } } }],
      ['unknown payload field', { status: 'resolved', payload: { answer: { choice: 'No' }, approved: true } }],
      ['no answer', { status: 'resolved', payload: {} }],
      ['no payload', { status: 'resolved' }],
      ['oversize answer', { status: 'resolved', payload: { answer: { choice: 'x'.repeat(17 * 1024) } } }],
      ['dismissal with payload', { status: 'cancelled', payload: { answer: { choice: 'No' } } }],
    ];
    for (const [label, entry] of cases) {
      const res = await post(resumeBody('wt-invalid', [{ interruptId: WIDGET_CALL, ...(entry as object) }]));
      assert.equal(res.status, 400, label);
      const body = await res.json();
      assert.equal(body.error, 'Invalid widget answer', label);
      assert.doesNotMatch(JSON.stringify(body), /secret-x/, label);
    }
    assert.equal(stub.modelCalls, 1);
    const session = sessions.get(SESSION_KEY);
    assert.ok(session.suspensions.has({ toolCallId: WIDGET_CALL }));
    assert.deepEqual(await listWidgetAnswers(specIndex, session, 'wt-invalid'), []);

    const ok = await readSse(
      await post(resumeBody('wt-invalid', [{ interruptId: WIDGET_CALL, status: 'resolved', payload: { answer: { choice: 'Yes' } } }])),
    );
    assert.equal(ok.find((e) => e.type === 'TOOL_CALL_RESULT')?.toolCallId, WIDGET_CALL);
    assert.deepEqual((await listWidgetAnswers(specIndex, session, 'wt-invalid'))[0].answer, { choice: 'Yes' });
  });

  it('mixing a widget answer with other decisions is refused (one widget per request)', async () => {
    await askWidget('wt-mixed');
    const answer = { interruptId: WIDGET_CALL, status: 'resolved', payload: { answer: { choice: 'No' } } };
    const two = await post(resumeBody('wt-mixed', [answer, { interruptId: 'other-call', status: 'resolved' }]));
    assert.equal(two.status, 400);
    const withProps = await post(
      resumeBody('wt-mixed', [answer], { forwardedProps: { tourbillon: { action: 'toolApproval', toolCallId: 'x', approved: true } } }),
    );
    assert.equal(withProps.status, 400);
    assert.ok(sessions.get(SESSION_KEY).suspensions.has({ toolCallId: WIDGET_CALL }));
  });

  it('a dismissal resumes the run with a dismissed result and stores no answer', async () => {
    await askWidget('wt-dismiss');
    const events = await readSse(await post(resumeBody('wt-dismiss', [{ interruptId: WIDGET_CALL, status: 'cancelled' }])));
    const result = events.find((e) => e.type === 'TOOL_CALL_RESULT');
    assert.deepEqual(JSON.parse(result!.content), { widget: 'testPicker', version: 1, dismissed: true });
    assert.equal(text(events), 'Thanks, noted.');
    assert.deepEqual(await listWidgetAnswers(specIndex, sessions.get(SESSION_KEY), 'wt-dismiss'), []);
  });

  it('a widget is answered once: of two concurrent answers one resumes, the other is refused; a late repeat changes nothing', async () => {
    await askWidget('wt-once');
    const body = (choice: string) =>
      resumeBody('wt-once', [{ interruptId: WIDGET_CALL, status: 'resolved', payload: { answer: { choice } } }]);
    const responses = await Promise.all([post(body('Yes')), post(body('No'))]);
    const outcomes = await Promise.all(
      responses.map(async (res) => {
        if (res.status !== 200) return { status: res.status, resumed: false, accepted: undefined };
        const events = await readSse(res);
        return {
          status: 200,
          resumed: events.some((e) => e.type === 'TOOL_CALL_RESULT'),
          accepted: events.find((e) => e.type === 'CUSTOM' && e.name !== 'tourbillon.tool_suspended')?.value?.accepted,
        };
      }),
    );
    const winners = outcomes.filter((o) => o.resumed);
    assert.equal(winners.length, 1, JSON.stringify(outcomes));
    const loser = outcomes.find((o) => !o.resumed)!;
    // Refused either up front (409, the thread's run is claimed) or as a decision with nothing pending.
    assert.ok(loser.status === 409 || loser.accepted === false, JSON.stringify(outcomes));
    await sleep(300);
    const session = sessions.get(SESSION_KEY);
    const stored = await listWidgetAnswers(specIndex, session, 'wt-once');
    assert.equal(stored.length, 1);
    const late = await readSse(await post(body('No')));
    assert.equal(late.find((e) => e.type === 'CUSTOM')?.value.accepted, false);
    assert.ok(!late.some((e) => e.type === 'TOOL_CALL_RESULT'));
    assert.deepEqual(await listWidgetAnswers(specIndex, session, 'wt-once'), stored);
    assert.equal(stub.modelCalls, 2);
  });

  it('another session of the agent, or a thread the widget is not on, cannot answer it', async () => {
    await askWidget('wt-session');
    const refused = async (res: Response, label: string) => {
      if (res.status === 200) {
        const events = await readSse(res);
        assert.ok(!events.some((e) => e.type === 'TOOL_CALL_RESULT'), label);
        assert.equal(events.find((e) => e.type === 'CUSTOM')?.value.accepted, false, label);
      } else {
        assert.equal(res.status, 404, label);
      }
    };
    const answer = [{ interruptId: WIDGET_CALL, status: 'resolved', payload: { answer: { choice: 'No' } } }];
    // The other session has nothing parked: not a widget answer there, and nothing resumes.
    await refused(await post(resumeBody('wt-session', answer, { forwardedProps: { tourbillon: { sessionScope: 'other' } } })), 'other session');
    await seedThread('wt-elsewhere');
    await refused(await post(resumeBody('wt-elsewhere', answer)), 'other thread');
    await sleep(300);
    const session = sessions.get(SESSION_KEY);
    assert.ok(session.suspensions.has({ toolCallId: WIDGET_CALL }));
    assert.equal(stub.modelCalls, 1);
    assert.deepEqual(await listWidgetAnswers(specIndex, session, 'wt-session'), []);
  });
});
