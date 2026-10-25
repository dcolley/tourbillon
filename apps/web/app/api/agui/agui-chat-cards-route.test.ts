/**
 * WID-3: question, choice, form and confirm cards over the AG-UI endpoint, end to end with the real
 * card specs — each card suspends the run, the answer (or a dismissal) comes back as an AG-UI `resume`
 * entry, is checked against the spec AND the props the card was asked with, resumes the tool and
 * reaches the model as the tool result. Also: answers outside the card are refused with the widget
 * still pending, one answer wins a race, and another company cannot see or answer the card.
 * Parked cards: a reopened chat gets the cards still waiting (action `pending`), a new run refused
 * because the run is parked on a card names the card (409 `pendingWidget`), and stopping the parked
 * run (action `abort` on its thread) lets the next message through.
 *
 * Same harness as agui-widgets-route.test.ts ('@/lib/chat' mocked at the registry boundary, a real
 * Mastra AgentController with a stub model), except the widget specs are the real ones and the agent
 * lookup is scoped to an active company, as resolveChatAgent is in production.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { requestScopedTools } from '@tourbillon/mastra/widget-tools';
import {
  createStubAgentController,
  createStubRequestContext,
  stubText,
  stubToolCall,
  type StubAgentController,
} from '../../../lib/agui/testing/stub-agent-controller';
import { listWidgetAnswers } from '../../../lib/agui/widgets';
import { resetWidgetOwnersForTests } from '../../../lib/agui/widget-owners';
import { assistantWidgetSpecIndex } from '../../../components/assistant/widgets/specs';

type Ev = Record<string, any>;
type Handler = (req: NextRequest, ctx: { params: Promise<{ agentId: string }> }) => Promise<Response>;

const AGENT_A = { id: 'agent-a', urlKey: 'alice', name: 'Alice', companyId: 'company-a', modelId: 'm' };
const AGENT_B = { id: 'agent-b', urlKey: 'bob', name: 'Bob', companyId: 'company-b', modelId: 'm' };
const RESOURCE_A = 'company-company-a:chat:free';
const RESOURCE_B = 'company-company-b:chat:free';
const SESSION_KEY = `${RESOURCE_A}::agui:agent-a`;
const OWNER = { agentId: AGENT_A.id };
const CALL = 'card-1';

/** The card the stub model asks on its first turn, per test. */
let asked: { name: string; args: Record<string, unknown> };
/** Company of the signed-in user (resolveChatAgent only finds agents in it). */
let activeCompany: string;

const CARDS = {
  askQuestion: {
    args: { question: 'What should the release note say?', maxLength: 40 },
    answer: { text: 'Faster board loading' },
    outside: { answer: { text: 'x'.repeat(41) }, issue: 'text: too_long' },
  },
  askChoice: {
    args: {
      question: 'Which plan?',
      options: [
        { id: 'basic', label: 'Basic' },
        { id: 'pro', label: 'Pro', description: 'More seats' },
      ],
      recommended: 'pro',
      defaultOption: 'basic',
    },
    answer: { choice: 'pro' },
    outside: { answer: { choice: 'enterprise' }, issue: 'choice: not_an_option' },
  },
  askForm: {
    args: {
      title: 'New project',
      fields: [
        { name: 'projectName', label: 'Name', type: 'text', maxLength: 60 },
        { name: 'seats', label: 'Seats', type: 'number', min: 1, max: 50, integer: true },
        { name: 'tier', label: 'Tier', type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
        { name: 'notes', label: 'Notes', type: 'text', required: false },
      ],
    },
    answer: { values: { projectName: 'Orbit', seats: 5, tier: 'b', notes: null } },
    outside: { answer: { values: { projectName: 'Orbit', seats: 500, tier: 'c', notes: null } }, issue: 'values.seats: too_big' },
  },
  askConfirm: {
    args: { question: 'Archive the old board?', reason: 'required', destructive: true },
    answer: { confirmed: false, reason: 'Still in use' },
    outside: { answer: { confirmed: true }, issue: 'reason: required' },
  },
} as const;
type CardName = keyof typeof CARDS;
const CARD_NAMES = Object.keys(CARDS) as CardName[];
const DECLARED = CARD_NAMES.map((name) => ({ name, description: 'client text is ignored', parameters: { type: 'object' } }));

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

async function readSse(res: Response): Promise<Ev[]> {
  const raw = await res.text();
  return raw
    .split('\n\n')
    .map((block) => block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join(''))
    .filter(Boolean)
    .map((json) => JSON.parse(json) as Ev);
}

function post(body: unknown, agentKey = 'alice') {
  return POST(
    new NextRequest(`http://localhost/api/agui/${agentKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ agentId: agentKey }) },
  );
}

const runBody = (threadId: string, extra: Record<string, unknown> = {}) => ({
  threadId,
  runId: `run-${Math.random().toString(36).slice(2)}`,
  messages: [{ id: 'u1', role: 'user', content: 'ask me something' }],
  tools: DECLARED,
  context: [],
  ...extra,
});

const resumeBody = (threadId: string, resume: unknown[], extra: Record<string, unknown> = {}) => ({
  threadId,
  runId: `run-${Math.random().toString(36).slice(2)}`,
  messages: [],
  tools: DECLARED,
  context: [],
  resume,
  ...extra,
});

const answerEntry = (answer: unknown) => ({ interruptId: CALL, status: 'resolved', payload: { answer } });

async function seedThread(threadId: string, resourceId = RESOURCE_A, agentId = AGENT_A.id) {
  const seeder = await stub.createSession(resourceId, `seed-${threadId}`);
  await seeder.thread.create({ id: threadId });
  await seeder.thread.setSetting({ key: 'agentId', value: agentId });
}

/** First run: the model asks the card; the run ends on an interrupt. */
async function askCard(threadId: string, name: CardName, args: Record<string, unknown> = CARDS[name].args as never) {
  asked = { name, args };
  await seedThread(threadId);
  const events = await readSse(await post(runBody(threadId)));
  await sleep(300); // the stream's settle window, so the run claim is released
  return events;
}

const owner = () => sessions.get(SESSION_KEY);
const pending = () => owner().suspensions.has({ toolCallId: CALL });

describe('WID-3 chat cards over AG-UI', () => {
  let originalRequire: any;

  before(async () => {
    const Module = require('module');
    originalRequire = Module.prototype.require;
    Module.prototype.require = function (id: string) {
      if (id === '@/lib/chat' || id.endsWith('/lib/chat') || id.endsWith('/lib/chat/index')) {
        return {
          ChatAgentError,
          // As in production: only agents of the active company resolve; anything else is a 404.
          resolveChatAgent: async (key: string) => {
            const agent = [AGENT_A, AGENT_B].find((a) => a.id === key || a.urlKey === key);
            if (agent && agent.companyId === activeCompany) return agent;
            throw new ChatAgentError('Agent not found', 404);
          },
          chatResourceId: (companyId: string) => `company-${companyId}:chat:free`,
          getOrCreateChatController: async () => stub.controller,
          getChatSession: async (_c: unknown, _a: unknown, opts: { resourceId: string; scope?: string }) => {
            const key = `${opts.resourceId}::${opts.scope ?? ''}`;
            if (!sessions.has(key)) sessions.set(key, await stub.createSession(opts.resourceId, opts.scope));
            return sessions.get(key);
          },
          createChatRequestContext: () => createStubRequestContext({ chatRequestContext: true }),
        };
      }
      if (id === '@/lib/company' || id.endsWith('/lib/company')) return { ActiveCompanyError };
      if (id === '@tourbillon/mastra') {
        return {
          runWithHeartbeatContext: async (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
          buildAssistantTracingOptions: () => undefined,
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
    sessions = new Map();
    activeCompany = AGENT_A.companyId;
    resetWidgetOwnersForTests();
    stub = await createStubAgentController({
      script: (_call, prompt) =>
        prompt.some((m) => m.role === 'tool') ? stubText('t', ['Thanks, noted.']) : stubToolCall(CALL, asked.name, asked.args),
      controllerTools: requestScopedTools as never,
    });
  });

  for (const name of CARD_NAMES) {
    const card = CARDS[name];

    it(`${name}: the card suspends the run, the answer resumes it as the tool result and is stored`, async () => {
      const first = await askCard(`wc-${name}`, name);
      const offered = stub.offeredTools[0].find((t: { name: string }) => t.name === name);
      assert.ok(offered, 'offered to the run');
      assert.equal(first.find((e) => e.type === 'TOOL_CALL_START')?.toolCallName, name);
      assert.equal(first.find((e) => e.type === 'CUSTOM' && e.name === 'tourbillon.tool_suspended')?.value.toolCallId, CALL);
      assert.equal(first.at(-1)?.outcome?.type, 'interrupt');
      assert.ok(pending());

      const events = await readSse(await post(resumeBody(`wc-${name}`, [answerEntry(card.answer)])));
      const result = events.find((e) => e.type === 'TOOL_CALL_RESULT');
      assert.equal(result?.toolCallId, CALL);
      assert.deepEqual(JSON.parse(result!.content), { widget: name, version: 1, answer: card.answer });
      assert.equal(events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta).join(''), 'Thanks, noted.');
      assert.equal(stub.modelCalls, 2);
      const stored = await listWidgetAnswers(assistantWidgetSpecIndex, owner(), `wc-${name}`, OWNER);
      assert.deepEqual(stored.map((a) => [a.widget, a.answer]), [[name, card.answer]]);
    });

    it(`${name}: an answer outside the card is refused (400, no values echoed) and the card stays pending`, async () => {
      await askCard(`wc-out-${name}`, name);
      const res = await post(resumeBody(`wc-out-${name}`, [answerEntry(card.outside.answer)]));
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'Invalid widget answer');
      // The route reports issues under `answer.` (path: code, never values).
      assert.ok(body.issues.includes(`answer.${card.outside.issue}`), JSON.stringify(body.issues));
      assert.doesNotMatch(JSON.stringify(body), /enterprise|xxxxxxxx|"c"/);
      assert.ok(pending());
      assert.equal(stub.modelCalls, 1);
      assert.deepEqual(await listWidgetAnswers(assistantWidgetSpecIndex, owner(), `wc-out-${name}`, OWNER), []);
      // The same card still takes a valid answer.
      const ok = await readSse(await post(resumeBody(`wc-out-${name}`, [answerEntry(card.answer)])));
      assert.deepEqual(JSON.parse(ok.find((e) => e.type === 'TOOL_CALL_RESULT')!.content).answer, card.answer);
    });

    it(`${name}: dismissing resumes the run with a dismissed result and stores no answer`, async () => {
      await askCard(`wc-dis-${name}`, name);
      const events = await readSse(await post(resumeBody(`wc-dis-${name}`, [{ interruptId: CALL, status: 'cancelled' }])));
      const result = events.find((e) => e.type === 'TOOL_CALL_RESULT');
      assert.deepEqual(JSON.parse(result!.content), { widget: name, version: 1, dismissed: true });
      assert.ok(!pending());
      assert.deepEqual(await listWidgetAnswers(assistantWidgetSpecIndex, owner(), `wc-dis-${name}`, OWNER), []);
    });
  }

  it('form: unknown fields, a missing required field and a value that is not an option are each refused', async () => {
    await askCard('wc-form-bad', 'askForm');
    const base = CARDS.askForm.answer.values;
    for (const [values, issue] of [
      [{ ...base, extra: 'x' }, 'values.extra: unknown_field'],
      [{ ...base, projectName: '  ' }, 'values.projectName: required'],
      [{ ...base, tier: 'zzz' }, 'values.tier: not_an_option'],
      [{ ...base, seats: 2.5 }, 'values.seats: not_integer'],
      [{ ...base, seats: '5' }, 'values.seats: invalid_type'],
    ] as const) {
      const res = await post(resumeBody('wc-form-bad', [answerEntry({ values })]));
      assert.equal(res.status, 400, issue);
      assert.ok((await res.json()).issues.includes(`answer.${issue}`), issue);
    }
    assert.ok(pending());
    assert.equal(stub.modelCalls, 1);
  });

  it('choice: of two concurrent answers exactly one resumes the run; a late repeat changes nothing', async () => {
    await askCard('wc-race', 'askChoice');
    const responses = await Promise.all([
      post(resumeBody('wc-race', [answerEntry({ choice: 'basic' })])),
      post(resumeBody('wc-race', [answerEntry({ choice: 'pro' })])),
    ]);
    const outcomes = await Promise.all(
      responses.map(async (res) => {
        if (res.status !== 200) return { status: res.status, resumed: false, accepted: undefined };
        const events = await readSse(res);
        return {
          status: 200,
          resumed: events.some((e) => e.type === 'TOOL_CALL_RESULT'),
          accepted: events.find((e) => e.type === 'CUSTOM' && e.name === 'tourbillon.control')?.value?.accepted,
        };
      }),
    );
    assert.equal(outcomes.filter((o) => o.resumed).length, 1, JSON.stringify(outcomes));
    const loser = outcomes.find((o) => !o.resumed)!;
    assert.ok(loser.status === 409 || loser.accepted === false, JSON.stringify(outcomes));
    await sleep(300);
    const stored = await listWidgetAnswers(assistantWidgetSpecIndex, owner(), 'wc-race', OWNER);
    assert.equal(stored.length, 1);
    const late = await readSse(await post(resumeBody('wc-race', [answerEntry({ choice: 'basic' })])));
    assert.equal(late.find((e) => e.type === 'CUSTOM')?.value.accepted, false);
    assert.ok(!late.some((e) => e.type === 'TOOL_CALL_RESULT'));
    assert.deepEqual(await listWidgetAnswers(assistantWidgetSpecIndex, owner(), 'wc-race', OWNER), stored);
    assert.equal(stub.modelCalls, 2);
  });

  it('another company cannot answer, dismiss or reach the card (its agent, its resource or its own agent)', async () => {
    await askCard('wc-company', 'askConfirm');
    const answer = [answerEntry(CARDS.askConfirm.answer)];
    // A user of company B: company A's agent does not resolve.
    activeCompany = AGENT_B.companyId;
    assert.equal((await post(resumeBody('wc-company', answer))).status, 404);
    assert.equal((await post(resumeBody('wc-company', [{ interruptId: CALL, status: 'cancelled' }]))).status, 404);
    // Company B's own agent cannot reach company A's thread.
    assert.equal((await post(resumeBody('wc-company', answer), 'bob')).status, 404);
    // A user of company A naming company B's resource is refused too.
    activeCompany = AGENT_A.companyId;
    const foreign = { forwardedProps: { tourbillon: { resourceId: RESOURCE_B } } };
    assert.equal((await post(resumeBody('wc-company', answer, foreign))).status, 404);
    // Nothing resumed; the owner still answers it.
    assert.ok(pending());
    assert.equal(stub.modelCalls, 1);
    assert.deepEqual(await listWidgetAnswers(assistantWidgetSpecIndex, owner(), 'wc-company', OWNER), []);
    const ok = await readSse(await post(resumeBody('wc-company', answer)));
    assert.deepEqual(JSON.parse(ok.find((e) => e.type === 'TOOL_CALL_RESULT')!.content).answer, CARDS.askConfirm.answer);
  });

  const pendingBody = (threadId: string, extra: Record<string, unknown> = {}) =>
    resumeBody(threadId, [], { forwardedProps: { tourbillon: { action: 'pending' } }, ...extra });
  const abortBody = (threadId: string) => ({
    ...runBody(threadId),
    messages: [],
    forwardedProps: { tourbillon: { action: 'abort' } },
  });
  const control = (events: Ev[]) => events.find((e) => e.type === 'CUSTOM' && e.name === 'tourbillon.control')?.value;

  it('a reopened chat gets its waiting card back (with its props) and can answer it', async () => {
    await askCard('wc-restore', 'askChoice');
    const before = control(await readSse(await post(pendingBody('wc-restore'))));
    assert.deepEqual(before, {
      action: 'pending',
      accepted: true,
      widgets: [{ toolCallId: CALL, toolName: 'askChoice', args: CARDS.askChoice.args }],
      parked: { threadId: 'wc-restore', toolCallId: CALL, toolName: 'askChoice', label: 'Which plan?' },
    });
    assert.ok(pending(), 'asking does not claim or resume anything');
    assert.equal(stub.modelCalls, 1);
    const events = await readSse(await post(resumeBody('wc-restore', [answerEntry(CARDS.askChoice.answer)])));
    assert.deepEqual(JSON.parse(events.find((e) => e.type === 'TOOL_CALL_RESULT')!.content).answer, CARDS.askChoice.answer);
    await sleep(300);
    assert.deepEqual(control(await readSse(await post(pendingBody('wc-restore')))), {
      action: 'pending',
      accepted: true,
      widgets: [],
      parked: null,
    });
  });

  it('a restored card can be dismissed', async () => {
    await askCard('wc-restore-dis', 'askForm');
    const value = control(await readSse(await post(pendingBody('wc-restore-dis'))));
    assert.deepEqual(value.widgets.map((w: Ev) => [w.toolCallId, w.toolName]), [[CALL, 'askForm']]);
    assert.equal(value.parked.label, 'New project');
    const events = await readSse(await post(resumeBody('wc-restore-dis', [{ interruptId: CALL, status: 'cancelled' }])));
    assert.deepEqual(JSON.parse(events.find((e) => e.type === 'TOOL_CALL_RESULT')!.content), { widget: 'askForm', version: 1, dismissed: true });
    assert.ok(!pending());
  });

  it('another company does not get the waiting card', async () => {
    await askCard('wc-restore-co', 'askQuestion');
    activeCompany = AGENT_B.companyId;
    assert.equal((await post(pendingBody('wc-restore-co'))).status, 404);
    assert.equal((await post(pendingBody('wc-restore-co'), 'bob')).status, 404);
    activeCompany = AGENT_A.companyId;
    const foreign = { forwardedProps: { tourbillon: { action: 'pending', resourceId: RESOURCE_B } } };
    assert.equal((await post(resumeBody('wc-restore-co', [], foreign))).status, 404);
    assert.ok(pending());
  });

  it('a message refused while the run is parked on a card names the card; Stop clears it and the next message runs', async () => {
    await seedThread('wc-parked-2'); // seeded first: the harness seeds with its own session
    await askCard('wc-parked', 'askQuestion');
    const refused = await post(runBody('wc-parked'));
    assert.equal(refused.status, 409);
    const body = await refused.json();
    assert.deepEqual(body.pendingWidget, {
      threadId: 'wc-parked',
      toolCallId: CALL,
      toolName: 'askQuestion',
      label: 'What should the release note say?',
    });
    assert.match(body.error, /question card \(“What should the release note say\?”\) in this chat is waiting for your answer/);
    assert.match(body.error, /stop the run/);

    // Another chat of the same agent: the card is named as being in another chat.
    const elsewhere = await post(runBody('wc-parked-2'));
    assert.equal(elsewhere.status, 409);
    const other = await elsewhere.json();
    assert.equal(other.pendingWidget.threadId, 'wc-parked');
    assert.match(other.error, /in another chat with this agent/);

    // Stop: abort on the parked run's thread.
    const stopped = control(await readSse(await post(abortBody('wc-parked'))));
    assert.deepEqual(stopped, { action: 'abort', accepted: true });
    await sleep(300);
    assert.equal(owner().getCurrentRunId() ?? null, null);
    assert.equal(control(await readSse(await post(pendingBody('wc-parked')))).parked, null);

    // The next message runs (the stub model asks its card again).
    const next = await post(runBody('wc-parked-2'));
    assert.equal(next.status, 200);
    const events = await readSse(next);
    assert.equal(events[0]?.type, 'RUN_STARTED');
    assert.ok(events.some((e) => e.type === 'TOOL_CALL_START'));
  });

  it('a form asking for a credential-like field is refused before it reaches the user (no suspension)', async () => {
    const events = await askCard('wc-secret', 'askForm', {
      title: 'Connect',
      fields: [{ name: 'apiKey', label: 'API key', type: 'text' }],
    });
    assert.notEqual(events.at(-1)?.outcome?.type, 'interrupt');
    assert.ok(!events.some((e) => e.type === 'CUSTOM' && e.name === 'tourbillon.tool_suspended'));
    assert.ok(!owner()?.suspensions.has({ toolCallId: CALL }));
  });
});
