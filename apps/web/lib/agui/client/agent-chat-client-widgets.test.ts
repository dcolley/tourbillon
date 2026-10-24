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
import { controlResponse, createFakeAguiServer, jsonError, until, type FakeRequest } from './testing/fake-agui-server';

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
});
