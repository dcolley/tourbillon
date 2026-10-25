/**
 * WID-3: the chat client answers and dismisses suspended widget calls with an AG-UI `resume` entry
 * (no explicit action), adopts the resumed run, and keeps the card answerable when the answer is
 * refused. Every request is also checked with the endpoint's own input parser.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentChatClient, WIDGET_NOT_PENDING_MESSAGE } from './agent-chat-client';
import type { AgentChatItem } from './chat-state';
import { parseAguiRequest } from '../run-input';
import { controlResponse, createFakeAguiServer, jsonError, tick, until, type FakeRequest } from './testing/fake-agui-server';

const THREAD = 'thread-1';
let ids = 0;
const newId = () => `id-${++ids}`;
const CALL = 'card-1';

const started = (req: FakeRequest) => ({ type: 'RUN_STARTED', threadId: req.body.threadId, runId: req.body.runId });
const finished = (req: FakeRequest, type = 'success') => ({ type: 'RUN_FINISHED', threadId: req.body.threadId, runId: req.body.runId, outcome: { type } });
const tool = (s: { items: AgentChatItem[] }) => s.items.find((i) => i.kind === 'tool') as Extract<AgentChatItem, { kind: 'tool' }>;

/** Runs a first turn that asks the choice card and ends on an interrupt; `onResume` answers the resume request. */
async function askedCard(onResume: (req: FakeRequest) => Response | 'stream') {
  const server = createFakeAguiServer((req) => (req.body.resume ? onResume(req) : 'stream'));
  const client = new AgentChatClient({
    agentId: 'alice',
    threadId: THREAD,
    fetch: server.fetch,
    newId,
    retry: { attempts: 0, delayMs: 1 },
    tools: [{ name: 'askChoice', description: 'd', parameters: { type: 'object' } }],
  });
  void client.send('pick a plan');
  await until(() => server.streams.length === 1);
  const req = server.requests[0];
  server.streams[0].send(
    started(req),
    { type: 'TOOL_CALL_START', toolCallId: CALL, toolCallName: 'askChoice' },
    { type: 'TOOL_CALL_ARGS', toolCallId: CALL, delta: '{"question":"Which?","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}' },
    { type: 'TOOL_CALL_END', toolCallId: CALL },
    { type: 'CUSTOM', name: 'tourbillon.tool_suspended', value: { toolCallId: CALL, toolName: 'askChoice' } },
    finished(req, 'interrupt'),
  );
  server.streams[0].close();
  await client.whenIdle();
  assert.equal(tool(client.getState()).status, 'suspended');
  assert.equal(client.getState().pendingTools.length, 1);
  return { server, client };
}

describe('WID-3 AgentChatClient widget answers', () => {
  it('answer / dismiss inputs carry a resume entry and pass the endpoint parser as one decision', () => {
    const client = new AgentChatClient({ agentId: 'alice', threadId: THREAD, newId });
    for (const entry of [
      { interruptId: CALL, status: 'resolved' as const, payload: { answer: { choice: 'a' } } },
      { interruptId: CALL, status: 'cancelled' as const },
    ]) {
      const input = client.buildInput('toolApproval', undefined, {}, [entry]);
      assert.equal((input.forwardedProps.tourbillon as Record<string, unknown>).action, undefined);
      const parsed = parseAguiRequest(JSON.parse(JSON.stringify(input)));
      assert.equal(parsed.action, 'toolApproval');
      assert.equal(parsed.toolDecisions.length, 1);
      assert.deepEqual(parsed.resume, [
        { toolCallId: CALL, status: entry.status, ...('payload' in entry ? { payload: entry.payload } : {}) },
      ]);
    }
  });

  it('answerWidget sends the answer, adopts the resumed run and shows the stored result', async () => {
    const { server, client } = await askedCard(() => 'stream');
    const answering = client.answerWidget(CALL, { choice: 'b' });
    assert.equal(tool(client.getState()).widgetSend?.phase, 'sending');
    await until(() => server.streams.length === 2);
    const req = server.requests[1];
    assert.deepEqual(req.body.resume, [{ interruptId: CALL, status: 'resolved', payload: { answer: { choice: 'b' } } }]);
    assert.equal(req.body.forwardedProps.tourbillon.action, undefined);
    const content = JSON.stringify({ widget: 'askChoice', version: 1, answer: { choice: 'b' } });
    server.streams[1].send(started(req), { type: 'TOOL_CALL_RESULT', messageId: 'r', toolCallId: CALL, role: 'tool', content });
    const r = await answering;
    assert.equal(r.ok, true);
    assert.deepEqual(client.getState().pendingTools, []);
    server.streams[1].send(finished(req));
    server.streams[1].close();
    await client.whenIdle();
    const item = tool(client.getState());
    assert.equal(item.status, 'done');
    assert.equal(item.result, content);
    assert.equal(item.widgetSend?.phase, 'sent');
  });

  it('dismissWidget sends a cancelled entry without a payload', async () => {
    const { server, client } = await askedCard(() => 'stream');
    void client.dismissWidget(CALL);
    await until(() => server.streams.length === 2);
    assert.deepEqual(server.requests[1].body.resume, [{ interruptId: CALL, status: 'cancelled' }]);
    server.streams[1].send(started(server.requests[1]), finished(server.requests[1]));
    server.streams[1].close();
    await client.whenIdle();
  });

  it('a refused answer (400) keeps the card pending and answerable again (attempt counted)', async () => {
    const { client } = await askedCard(() => jsonError(400, 'Invalid widget answer'));
    const r = await client.answerWidget(CALL, { choice: 'z' });
    assert.equal(r.ok, false);
    const state = client.getState();
    assert.deepEqual(state.error, { kind: 'http', message: 'Invalid widget answer', status: 400 });
    assert.deepEqual(tool(state).widgetSend, { phase: 'failed', attempts: 1 });
    assert.equal(tool(state).status, 'suspended');
    assert.equal(state.pendingTools.length, 1);
  });

  it('an answer that reaches a card no longer waiting (lost race) is reported, nothing resumes', async () => {
    const { server, client } = await askedCard((req) =>
      controlResponse(req.body, { accepted: false, toolCallIds: [CALL], results: [{ toolCallId: CALL, accepted: false, reason: 'not_pending' }] }),
    );
    const r = await client.answerWidget(CALL, { choice: 'a' });
    assert.equal(r.ok, false);
    assert.equal(client.getState().error?.message, WIDGET_NOT_PENDING_MESSAGE);
    assert.equal(tool(client.getState()).widgetSend?.phase, 'failed');
    assert.equal(server.streams.length, 1);
    assert.equal(client.isRunOpen, false);
  });

  // ---- WID-3 parked cards: restore after reload, refused send names the card, Stop ----

  const CARD_ARGS = { question: 'Which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
  const parkedHere = { threadId: THREAD, toolCallId: CALL, toolName: 'askChoice', label: 'Which?' };
  const conflict = (pendingWidget: Record<string, unknown>) =>
    new Response(JSON.stringify({ error: 'A choice card (“Which?”) in this chat is waiting for your answer.', pendingWidget }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  const freshClient = (server: ReturnType<typeof createFakeAguiServer>) =>
    new AgentChatClient({ agentId: 'alice', threadId: THREAD, fetch: server.fetch, newId, retry: { attempts: 0, delayMs: 1 } });

  it('restorePending shows the waiting card again (answerable) and the answer resumes the run', async () => {
    const server = createFakeAguiServer((req) =>
      req.action === 'pending'
        ? controlResponse(req.body, { accepted: true, widgets: [{ toolCallId: CALL, toolName: 'askChoice', args: CARD_ARGS }], parked: parkedHere })
        : 'stream',
    );
    const client = freshClient(server);
    const r = await client.restorePending();
    assert.equal(r.ok, true);
    const parsed = parseAguiRequest(JSON.parse(JSON.stringify(server.requests[0].body)));
    assert.equal(parsed.action, 'pending');
    const s = client.getState();
    assert.deepEqual(tool(s), { kind: 'tool', id: CALL, name: 'askChoice', argsText: JSON.stringify(CARD_ARGS), status: 'suspended' });
    assert.deepEqual(s.pendingTools, [{ toolCallId: CALL, toolName: 'askChoice', reason: 'tool_suspended', args: CARD_ARGS }]);
    assert.deepEqual(s.parked, { ...parkedHere, elsewhere: false });
    assert.equal(s.error, null);

    const answering = client.answerWidget(CALL, { choice: 'a' });
    await until(() => server.streams.length === 1);
    const req = server.requests[1];
    assert.deepEqual(req.body.resume, [{ interruptId: CALL, status: 'resolved', payload: { answer: { choice: 'a' } } }]);
    const content = JSON.stringify({ widget: 'askChoice', version: 1, answer: { choice: 'a' } });
    server.streams[0].send(started(req), { type: 'TOOL_CALL_RESULT', messageId: 'r', toolCallId: CALL, role: 'tool', content });
    assert.equal((await answering).ok, true);
    server.streams[0].send(finished(req));
    server.streams[0].close();
    await client.whenIdle();
    assert.equal(tool(client.getState()).status, 'done');
    assert.equal(client.getState().parked, null);
    assert.deepEqual(client.getState().pendingTools, []);
  });

  it('restorePending failures are silent (no error shown)', async () => {
    const server = createFakeAguiServer(() => jsonError(500, 'boom'));
    const client = freshClient(server);
    const r = await client.restorePending();
    assert.equal(r.ok, false);
    assert.equal(client.getState().error, null);
    assert.deepEqual(client.getState().items, []);
  });

  it('a send refused because the run is parked names the card, shows it, and Stop clears it so the next send runs', async () => {
    let parked = true;
    const server = createFakeAguiServer((req) => {
      if (req.action === 'pending') {
        return controlResponse(req.body, {
          accepted: true,
          widgets: parked ? [{ toolCallId: CALL, toolName: 'askChoice', args: CARD_ARGS }] : [],
          parked: parked ? parkedHere : null,
        });
      }
      if (req.action === 'abort') {
        const was = parked;
        parked = false;
        return controlResponse(req.body, { accepted: was });
      }
      return parked ? conflict(parkedHere) : 'stream';
    });
    const client = freshClient(server);
    const sent = await client.send('hello');
    assert.equal(sent.ok, false);
    assert.equal(sent.ok === false && sent.error.kind, 'conflict');
    assert.deepEqual(sent.ok === false && sent.error.pendingWidget, { ...parkedHere, elsewhere: false });
    assert.match(client.getState().error!.message, /choice card/);
    assert.deepEqual(client.getState().parked, { ...parkedHere, elsewhere: false });
    // The card was not shown (e.g. after a reload): it is fetched and shown.
    await until(() => tool(client.getState())?.status === 'suspended', 2000, 'card restored');
    assert.deepEqual(server.requests.map((r) => r.action), ['run', 'pending']);

    // Stop with no run stream open stops the parked run on its thread.
    const stopped = await client.abort();
    assert.equal(stopped.ok, true);
    const abortReq = server.requests[2];
    assert.equal(abortReq.action, 'abort');
    assert.equal(abortReq.body.threadId, THREAD);
    assert.equal(parseAguiRequest(JSON.parse(JSON.stringify(abortReq.body))).action, 'abort');
    const s = client.getState();
    assert.equal(s.parked, null);
    assert.deepEqual(s.pendingTools, []);
    assert.equal(tool(s).status, 'stopped');
    assert.equal(s.error, null);

    // The next send runs.
    const again = client.send('hello again');
    await until(() => server.streams.length === 1);
    const req = server.requests[3];
    assert.equal(req.action, 'run');
    server.streams[0].send(started(req));
    assert.equal((await again).ok, true);
    server.streams[0].send(finished(req));
    server.streams[0].close();
    await client.whenIdle();
  });

  it('a card parked in another chat is named as elsewhere; Stop aborts on that chat', async () => {
    const elsewhere = { threadId: 'thread-0', toolCallId: 'card-0', toolName: 'askForm', label: 'Setup' };
    let parked = true;
    const server = createFakeAguiServer((req) => {
      if (req.action === 'abort') {
        parked = false;
        return controlResponse(req.body, { accepted: true });
      }
      return parked ? conflict(elsewhere) : 'stream';
    });
    const client = freshClient(server);
    await client.send('hello');
    assert.deepEqual(client.getState().parked, { ...elsewhere, elsewhere: true });
    await tick(20);
    assert.deepEqual(server.requests.map((r) => r.action), ['run'], 'nothing to restore here');
    await client.abort();
    assert.equal(server.requests[1].action, 'abort');
    assert.equal(server.requests[1].body.threadId, 'thread-0');
    assert.equal(client.getState().parked, null);
  });

  it('abort with no run open and nothing parked sends nothing', async () => {
    const server = createFakeAguiServer(() => 'stream');
    const client = freshClient(server);
    assert.deepEqual(await client.abort(), { ok: true, value: { accepted: false } });
    assert.equal(server.requests.length, 0);
  });
});
