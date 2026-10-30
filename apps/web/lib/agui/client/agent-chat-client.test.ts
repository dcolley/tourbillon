/**
 * AGUI-1b: client state machine for POST /api/agui/[agentId], against a scripted fake endpoint:
 * streaming, follow-up queue, steer, abort, 409 handling, tool approval, disconnect and dispose.
 * Every request the client builds is also checked with the endpoint's own input parser.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentChatClient } from './agent-chat-client';
import type { AgentChatItem, AgentChatState } from './chat-state';
import { parseAguiRequest } from '../run-input';
import {
  controlResponse,
  createFakeAguiServer,
  jsonError,
  tick,
  until,
  type FakeRequest,
  type OpenStream,
} from './testing/fake-agui-server';

const THREAD = 'thread-1';
const RESOURCE = 'company-co-1:chat:free';

let ids = 0;
const newId = () => `id-${++ids}`;

function setup(handler: Parameters<typeof createFakeAguiServer>[0], extra: Partial<ConstructorParameters<typeof AgentChatClient>[0]> = {}) {
  const server = createFakeAguiServer(handler);
  const events: string[] = [];
  const client = new AgentChatClient({
    agentId: 'alice',
    threadId: THREAD,
    resourceId: RESOURCE,
    fetch: server.fetch,
    newId,
    retry: { attempts: 3, delayMs: 5 },
    onRunEvent: (e) => events.push(e.type),
    ...extra,
  });
  const states: AgentChatState[] = [];
  client.subscribe(() => states.push(client.getState()));
  return { server, client, states, events };
}

const users = (s: AgentChatState) =>
  s.items.filter((i): i is Extract<AgentChatItem, { kind: 'user' }> => i.kind === 'user');
const assistantText = (s: AgentChatState) =>
  s.items.filter((i) => i.kind === 'assistant').map((i) => (i as { text: string }).text).join('|');
const started = (req: FakeRequest) => ({ type: 'RUN_STARTED', threadId: req.body.threadId, runId: req.body.runId });
const finished = (req: FakeRequest, type = 'success') => ({
  type: 'RUN_FINISHED',
  threadId: req.body.threadId,
  runId: req.body.runId,
  outcome: { type },
});
const text = (messageId: string, ...deltas: string[]) => [
  { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
  ...deltas.map((delta) => ({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta })),
  { type: 'TEXT_MESSAGE_END', messageId },
];

/** A fake that streams the run and answers controls with `controls[action]`. */
type Answer = Response | 'stream' | Promise<Response | 'stream'>;
function runAndControls(controls: Record<string, (req: FakeRequest) => Answer> = {}) {
  return (req: FakeRequest): Answer =>
    req.action === 'run' ? 'stream' : (controls[req.action]?.(req) ?? controlResponse(req.body, { accepted: true }));
}

describe('AGUI-1b AgentChatClient', () => {
  describe('requests match the endpoint input contract', () => {
    it('run / followUp / steer / abort / toolApproval inputs pass parseAguiRequest', () => {
      const client = new AgentChatClient({
        agentId: 'alice',
        threadId: THREAD,
        resourceId: RESOURCE,
        sessionScope: 'tab-1',
        context: { contextType: 'free' },
        newId,
      });
      for (const [action, message, extra] of [
        ['run', 'hello', {}],
        ['followUp', 'and then', {}],
        ['steer', 'shorter please', {}],
        ['abort', undefined, {}],
        ['toolApproval', undefined, { toolCallId: 'call-1', approved: false }],
      ] as const) {
        const input = client.buildInput(action, message, extra);
        const parsed = parseAguiRequest(JSON.parse(JSON.stringify(input)));
        assert.equal(parsed.action, action);
        assert.equal(parsed.input.threadId, THREAD);
        assert.equal(parsed.props.resourceId, RESOURCE);
        assert.equal(parsed.props.sessionScope, 'tab-1');
        assert.equal(parsed.message, message ?? '');
        if (action === 'toolApproval') assert.deepEqual(parsed.toolDecisions, [{ toolCallId: 'call-1', approved: false }]);
      }
    });

    it('each request gets a fresh runId and sends only the new user message', async () => {
      const { server, client } = setup(runAndControls());
      void client.send('first');
      await until(() => server.streams.length === 1);
      await client.send('second');
      const [a, b] = server.requests;
      assert.notEqual(a.body.runId, b.body.runId);
      assert.deepEqual(a.body.messages.map((m: { content: string }) => m.content), ['first']);
      assert.deepEqual(b.body.messages.map((m: { content: string }) => m.content), ['second']);
      assert.equal(a.url, '/api/agui/alice');
      server.streams[0].close();
      await client.whenIdle();
    });
  });

  describe('streaming', () => {
    it('streams text, a tool call and its result, then RUN_FINISHED → idle', async () => {
      const { server, client, states, events } = setup(runAndControls());
      const res = await client.send('please echo hi');
      assert.deepEqual(res, { ok: true });
      await until(() => server.streams.length === 1);
      const req = server.requests[0];
      const s = server.streams[0];
      s.send(started(req));
      await until(() => client.getState().status === 'running', 2000, 'running');
      assert.equal(users(client.getState())[0].delivery, 'delivered');
      s.send(
        { type: 'TOOL_CALL_START', toolCallId: 'call-1', toolCallName: 'echo', parentMessageId: 'm1' },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'call-1', delta: '{"text":' },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'call-1', delta: '"hi"}' },
        { type: 'TOOL_CALL_END', toolCallId: 'call-1' },
      );
      await until(() => client.getState().items.some((i) => i.kind === 'tool' && i.status === 'running'));
      s.send(
        { type: 'TOOL_CALL_RESULT', messageId: 'call-1:result', toolCallId: 'call-1', role: 'tool', content: '{"echoed":"hi"}' },
        ...text('m2', 'Hello ', 'there'),
      );
      s.raw(': keep-alive\n\n');
      await until(() => assistantText(client.getState()) === 'Hello there');
      const streaming = client.getState().items.find((i) => i.kind === 'assistant') as { streaming: boolean };
      assert.equal(streaming.streaming, false, 'TEXT_MESSAGE_END closes the message');
      s.send(finished(req));
      s.close();
      await client.whenIdle();
      const end = client.getState();
      assert.equal(end.status, 'idle');
      assert.equal(end.lastOutcome, 'success');
      assert.equal(end.error, null);
      assert.deepEqual(
        end.items.map((i) => i.kind),
        ['user', 'tool', 'assistant'],
      );
      const tool = end.items[1] as Extract<AgentChatItem, { kind: 'tool' }>;
      assert.equal(tool.name, 'echo');
      assert.equal(tool.argsText, '{"text":"hi"}');
      assert.equal(tool.status, 'done');
      assert.equal(tool.result, '{"echoed":"hi"}');
      assert.ok(states.some((st) => st.status === 'starting'));
      assert.equal(events[0], 'RUN_STARTED');
      assert.equal(events.at(-1), 'RUN_FINISHED');
    });

    it('text split across network chunks and CRLF line endings still parse', async () => {
      const { server, client } = setup(runAndControls());
      void client.send('hi');
      await until(() => server.streams.length === 1);
      const req = server.requests[0];
      const raw = `data: ${JSON.stringify(started(req))}\r\n\r\ndata: ${JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'abc' })}\r\n\r\n`;
      server.streams[0].raw(raw.slice(0, 17));
      server.streams[0].raw(raw.slice(17, 60));
      server.streams[0].raw(raw.slice(60));
      server.streams[0].send(finished(req));
      server.streams[0].close();
      await client.whenIdle();
      assert.equal(assistantText(client.getState()), 'abc');
      assert.equal(client.getState().lastOutcome, 'success');
    });

    it('RUN_ERROR ends the run with a run error', async () => {
      const { server, client } = setup(runAndControls());
      void client.send('hi');
      await until(() => server.streams.length === 1);
      server.streams[0].send(started(server.requests[0]), { type: 'RUN_ERROR', message: 'model failed', code: 'agent_error' });
      server.streams[0].close();
      await client.whenIdle();
      assert.equal(client.getState().status, 'idle');
      assert.deepEqual(client.getState().error, { kind: 'run', message: 'model failed' });
      assert.equal(client.getState().lastOutcome, 'error');
    });

    it('events after RUN_FINISHED are ignored', async () => {
      const { server, client } = setup(runAndControls());
      void client.send('hi');
      await until(() => server.streams.length === 1);
      const req = server.requests[0];
      server.streams[0].send(started(req), ...text('m', 'a'), finished(req), ...text('late', 'zzz'));
      server.streams[0].close();
      await client.whenIdle();
      assert.equal(assistantText(client.getState()), 'a');
    });
  });

  describe('follow-up queue', () => {
    it('a message sent while a run is open is a follow-up: queued, then delivered on the same run', async () => {
      const { server, client } = setup(runAndControls({ followUp: (req) => controlResponse(req.body, { accepted: true, queued: 1 }) }));
      void client.send('first');
      await until(() => server.streams.length === 1);
      const req = server.requests[0];
      server.streams[0].send(started(req), ...text('m1', 'one'));
      await until(() => client.getState().status === 'running');
      const r = await client.send('second');
      assert.equal(r.ok, true);
      assert.equal(server.requests[1].action, 'followUp');
      assert.deepEqual(users(client.getState()).map((u) => [u.mode, u.delivery]), [
        ['run', 'delivered'],
        ['followUp', 'queued'],
      ]);
      server.streams[0].send(...text('m2', 'two'), finished(req));
      server.streams[0].close();
      await client.whenIdle();
      assert.equal(server.requests.length, 2, 'the follow-up streams on the open run, no new run request');
      assert.equal(assistantText(client.getState()), 'one|two');
      assert.equal(users(client.getState())[1].delivery, 'delivered');
    });

    it('follow-ups the endpoint reports dropped are marked, newest first; the rest are delivered', async () => {
      let n = 0;
      const { server, client } = setup(runAndControls({ followUp: (req) => controlResponse(req.body, { accepted: true, queued: ++n }) }));
      void client.send('first');
      await until(() => server.streams.length === 1);
      const req = server.requests[0];
      server.streams[0].send(started(req));
      await until(() => client.getState().status === 'running');
      await client.send('f1');
      await client.send('f2');
      await client.send('f3');
      server.streams[0].send({ type: 'CUSTOM', name: 'tourbillon.follow_up_dropped', value: { count: 1 } });
      // The endpoint reports a running total; a repeat of the same total marks nothing more.
      server.streams[0].send({ type: 'CUSTOM', name: 'tourbillon.follow_up_dropped', value: { count: 1 } });
      server.streams[0].send(finished(req));
      server.streams[0].close();
      await client.whenIdle();
      assert.deepEqual(users(client.getState()).slice(1).map((u) => [u.text, u.delivery]), [
        ['f1', 'delivered'],
        ['f2', 'delivered'],
        ['f3', 'dropped'],
      ]);
    });

    it('a follow-up refused by the endpoint is failed and the run carries on', async () => {
      const { server, client } = setup(
        runAndControls({ followUp: () => jsonError(409, 'The run on this thread belongs to another session') }),
      );
      void client.send('first');
      await until(() => server.streams.length === 1);
      server.streams[0].send(started(server.requests[0]));
      await until(() => client.getState().status === 'running');
      const r = await client.send('second');
      assert.equal(r.ok, false);
      assert.equal(server.requests.length, 2, 'not retried: another session holds the run');
      const st = client.getState();
      assert.deepEqual(st.error, { kind: 'conflict', status: 409, message: 'The run on this thread belongs to another session' });
      assert.equal(users(st)[1].delivery, 'failed');
      assert.equal(st.status, 'running');
      assert.equal(client.isRunOpen, true);
      server.streams[0].send(finished(server.requests[0]));
      server.streams[0].close();
      await client.whenIdle();
    });

    it('a follow-up answered after the run already ended is dropped (it will not run)', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const { server, client } = setup(
        runAndControls({
          followUp: async (req) => {
            await gate; // answer only after the run has finished
            return controlResponse(req.body, { accepted: true, queued: 1 });
          },
        }),
      );
      void client.send('first');
      await until(() => server.streams.length === 1);
      server.streams[0].send(started(server.requests[0]));
      await until(() => client.getState().status === 'running');
      const pending = client.send('late follow-up');
      await until(() => server.requests.length === 2);
      server.streams[0].send(finished(server.requests[0]));
      server.streams[0].close();
      await client.whenIdle();
      release();
      await pending;
      assert.equal(users(client.getState())[1].delivery, 'dropped');
    });
  });

  describe('steer', () => {
    it('steer while running is a control action; the user message is delivered', async () => {
      const { server, client } = setup(runAndControls());
      void client.send('first');
      await until(() => server.streams.length === 1);
      server.streams[0].send(started(server.requests[0]));
      await until(() => client.getState().status === 'running');
      const r = await client.steer('shorter');
      assert.equal(r.ok, true);
      assert.equal(server.requests[1].action, 'steer');
      assert.deepEqual(users(client.getState()).map((u) => [u.mode, u.delivery]).at(-1), ['steer', 'delivered']);
      server.streams[0].send(finished(server.requests[0]));
      server.streams[0].close();
      await client.whenIdle();
    });

    it('steer with no open run just starts a run', async () => {
      const { server, client } = setup(runAndControls());
      await client.steer('hello');
      assert.equal(server.requests[0].action, 'run');
      server.streams[0].close();
      await client.whenIdle();
    });

    it('a control response that is a run (idle session) is adopted as the open run', async () => {
      const { server, client } = setup(() => 'stream');
      void client.send('first');
      await until(() => server.streams.length === 1);
      const first = server.requests[0];
      server.streams[0].send(started(first));
      await until(() => client.getState().status === 'running');
      // The endpoint started a new turn for the follow-up (its session was idle) instead of queueing it.
      const pending = client.send('again');
      await until(() => server.streams.length === 2);
      const second = server.requests[1];
      server.streams[1].send(started(second), ...text('m2', 'new turn'));
      const r = await pending;
      assert.deepEqual(r, { ok: true, value: { accepted: true, startedRun: true } });
      assert.equal(users(client.getState())[1].delivery, 'delivered');
      assert.equal(server.streams[0].aborted, false, 'the old stream is detached, not closed (that would stop the new run)');
      server.streams[1].send(finished(second));
      server.streams[1].close();
      await client.whenIdle();
      assert.equal(client.getState().runId, second.body.runId);
      assert.equal(client.getState().lastOutcome, 'success');
    });
  });

  describe('abort', () => {
    it('abort asks the endpoint to stop; the open run ends cancelled and queued follow-ups are dropped', async () => {
      const { server, client, states } = setup(
        runAndControls({
          followUp: (req) => controlResponse(req.body, { accepted: true, queued: 1 }),
          abort: (req) => controlResponse(req.body, { accepted: true, droppedFollowUps: 1 }),
        }),
      );
      void client.send('first');
      await until(() => server.streams.length === 1);
      const req = server.requests[0];
      server.streams[0].send(started(req), ...text('m1', 'partial'));
      await until(() => client.getState().status === 'running');
      await client.send('queued one');
      const r = await client.abort();
      assert.equal(r.ok, true);
      assert.equal(server.requests[2].action, 'abort');
      assert.deepEqual(server.requests[2].body.messages, []);
      assert.ok(states.some((s) => s.status === 'stopping'));
      assert.equal(users(client.getState())[1].delivery, 'dropped', 'reported in the abort answer');
      assert.equal(server.streams[0].aborted, false, 'stream left open for RUN_FINISHED');
      server.streams[0].send(
        { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
        { type: 'CUSTOM', name: 'tourbillon.follow_up_dropped', value: { count: 1 } },
        finished(req, 'cancelled'),
      );
      server.streams[0].close();
      await client.whenIdle();
      const st = client.getState();
      assert.equal(st.status, 'idle');
      assert.equal(st.lastOutcome, 'cancelled');
      assert.equal(st.error, null);
      assert.equal(assistantText(st), 'partial');
      assert.equal(users(st)[0].delivery, 'delivered');
    });

    it('abort not accepted (nothing running on the endpoint) → the client closes the stream', async () => {
      const { server, client } = setup(runAndControls({ abort: (req) => controlResponse(req.body, { accepted: false }) }));
      void client.send('first');
      await until(() => server.streams.length === 1);
      server.streams[0].send(started(server.requests[0]));
      await until(() => client.getState().status === 'running');
      await client.abort();
      assert.equal(server.streams[0].aborted, true);
      await client.whenIdle();
      assert.equal(client.getState().status, 'idle');
      assert.equal(client.getState().lastOutcome, 'cancelled');
      assert.equal(client.getState().error, null);
    });

    it('abort request failing (409 / network) → the client closes the stream', async () => {
      const { server, client } = setup(
        runAndControls({ abort: () => jsonError(409, 'The run on this thread belongs to another session') }),
      );
      void client.send('first');
      await until(() => server.streams.length === 1);
      server.streams[0].send(started(server.requests[0]));
      await until(() => client.getState().status === 'running');
      const r = await client.abort();
      assert.equal(r.ok, false);
      assert.equal(server.streams[0].aborted, true);
      assert.equal(client.getState().status, 'idle');
      assert.equal(client.getState().lastOutcome, 'cancelled');
    });

    it('abort accepted but the run does not end in time → the client closes the stream', async () => {
      const { server, client } = setup(runAndControls(), { abortTimeoutMs: 20 });
      void client.send('first');
      await until(() => server.streams.length === 1);
      server.streams[0].send(started(server.requests[0]));
      await until(() => client.getState().status === 'running');
      await client.abort();
      assert.equal(client.getState().status, 'stopping');
      await until(() => server.streams[0].aborted, 1000, 'stream closed after timeout');
      await client.whenIdle();
      assert.equal(client.getState().lastOutcome, 'cancelled');
    });

    it('abort with no open run sends nothing', async () => {
      const { server, client } = setup(runAndControls());
      assert.deepEqual(await client.abort(), { ok: true, value: { accepted: false } });
      assert.equal(server.requests.length, 0);
    });
  });

  describe('409 handling', () => {
    it('run refused with 409 → conflict error, message kept as failed, no retry', async () => {
      const { server, client } = setup(() => jsonError(409, 'A run is already in progress; send steer or followUp instead'));
      const r = await client.send('hello');
      assert.equal(r.ok, false);
      assert.equal(server.requests.length, 1);
      const st = client.getState();
      assert.equal(st.status, 'idle');
      assert.equal(st.error?.kind, 'conflict');
      assert.equal(st.error?.status, 409);
      assert.match(st.error!.message, /already in progress/);
      assert.deepEqual(users(st).map((u) => u.delivery), ['failed']);
      assert.equal(client.isRunOpen, false);
    });

    it('control 409 "retry shortly" (run still being claimed) is retried, then succeeds', async () => {
      let tries = 0;
      const { server, client } = setup(
        runAndControls({
          followUp: (req) =>
            ++tries < 3
              ? jsonError(409, 'A run is starting on this thread; retry shortly')
              : controlResponse(req.body, { accepted: true, queued: 1 }),
        }),
      );
      void client.send('first');
      await until(() => server.streams.length === 1);
      server.streams[0].send(started(server.requests[0]));
      await until(() => client.getState().status === 'running');
      const r = await client.send('second');
      assert.equal(r.ok, true);
      assert.equal(server.requests.filter((q) => q.action === 'followUp').length, 3);
      assert.equal(users(client.getState())[1].delivery, 'queued');
      server.streams[0].send(finished(server.requests[0]));
      server.streams[0].close();
      await client.whenIdle();
    });

    it('control 409 "retry shortly" gives up after the retry budget', async () => {
      const { server, client } = setup(
        runAndControls({ steer: () => jsonError(409, 'A run is starting on this thread; retry shortly') }),
        { retry: { attempts: 2, delayMs: 1 } },
      );
      void client.send('first');
      await until(() => server.streams.length === 1);
      server.streams[0].send(started(server.requests[0]));
      await until(() => client.getState().status === 'running');
      const r = await client.steer('x');
      assert.equal(r.ok, false);
      assert.equal(server.requests.filter((q) => q.action === 'steer').length, 3);
      assert.equal(client.getState().error?.kind, 'conflict');
      server.streams[0].close();
      await client.whenIdle();
    });

    it('other HTTP errors are reported with their status', async () => {
      const { client } = setup(() => jsonError(404, 'Thread not found'));
      await client.send('hello');
      assert.deepEqual(client.getState().error, { kind: 'http', status: 404, message: 'Thread not found' });
    });

    it('fetch failure → network error', async () => {
      const { client } = setup(() => {
        throw new TypeError('Failed to fetch');
      });
      await client.send('hello');
      assert.deepEqual(client.getState().error, { kind: 'network', message: 'Failed to fetch' });
      assert.equal(client.getState().status, 'idle');
    });
  });

  describe('tool approval', () => {
    it('approval request → pending; approve → toolApproval control, pending cleared', async () => {
      const { server, client } = setup(
        runAndControls({
          toolApproval: (req) =>
            controlResponse(req.body, {
              accepted: true,
              toolCallIds: ['call-9'],
              results: [{ toolCallId: 'call-9', accepted: true }],
            }),
        }),
      );
      void client.send('delete it');
      await until(() => server.streams.length === 1);
      const req = server.requests[0];
      server.streams[0].send(
        started(req),
        { type: 'TOOL_CALL_START', toolCallId: 'call-9', toolCallName: 'deleteThing' },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'call-9', delta: '{"id":"x"}' },
        { type: 'TOOL_CALL_END', toolCallId: 'call-9' },
        { type: 'CUSTOM', name: 'tourbillon.tool_approval_required', value: { toolCallId: 'call-9', toolName: 'deleteThing', args: { id: 'x' } } },
      );
      await until(() => client.getState().pendingTools.length === 1);
      assert.deepEqual(client.getState().pendingTools[0], {
        toolCallId: 'call-9',
        toolName: 'deleteThing',
        reason: 'tool_approval',
        args: { id: 'x' },
      });
      const r = await client.respondToTool('call-9', true);
      assert.equal(r.ok, true);
      const sent = server.requests[1];
      assert.equal(sent.action, 'toolApproval');
      assert.deepEqual(
        { toolCallId: sent.body.forwardedProps.tourbillon.toolCallId, approved: sent.body.forwardedProps.tourbillon.approved },
        { toolCallId: 'call-9', approved: true },
      );
      assert.deepEqual(client.getState().pendingTools, []);
      server.streams[0].send(
        { type: 'TOOL_CALL_RESULT', messageId: 'r', toolCallId: 'call-9', role: 'tool', content: '{"ok":true}' },
        finished(req),
      );
      server.streams[0].close();
      await client.whenIdle();
      assert.equal((client.getState().items[1] as { status: string }).status, 'done');
    });

    it('a decision the endpoint did not apply keeps the tool pending and reports why', async () => {
      const { server, client } = setup(
        runAndControls({
          toolApproval: (req) =>
            controlResponse(req.body, {
              accepted: false,
              toolCallIds: ['call-9'],
              results: [{ toolCallId: 'call-9', accepted: false, reason: 'not_pending' }],
            }),
        }),
      );
      void client.send('x');
      await until(() => server.streams.length === 1);
      server.streams[0].send(started(server.requests[0]), {
        type: 'CUSTOM',
        name: 'tourbillon.tool_approval_required',
        value: { toolCallId: 'call-9', toolName: 't' },
      });
      await until(() => client.getState().pendingTools.length === 1);
      const r = await client.respondToTool('call-9', false);
      assert.equal(r.ok, false);
      assert.equal(client.getState().pendingTools.length, 1);
      assert.deepEqual(client.getState().error, { kind: 'rejected', message: 'Tool decision not applied (not_pending)' });
      server.streams[0].close();
      await client.whenIdle();
    });

    it('a denied tool result is shown as denied; an interrupt outcome keeps pending tools', async () => {
      const { server, client } = setup(runAndControls());
      void client.send('x');
      await until(() => server.streams.length === 1);
      const req = server.requests[0];
      server.streams[0].send(
        started(req),
        { type: 'TOOL_CALL_START', toolCallId: 'a', toolCallName: 't' },
        { type: 'TOOL_CALL_RESULT', messageId: 'r', toolCallId: 'a', role: 'tool', content: '', metadata: { isError: false, denied: true } },
        { type: 'CUSTOM', name: 'tourbillon.tool_suspended', value: { toolCallId: 'b', toolName: 'ask' } },
        finished(req, 'interrupt'),
      );
      server.streams[0].close();
      await client.whenIdle();
      const st = client.getState();
      assert.equal((st.items[1] as { status: string }).status, 'denied');
      assert.equal(st.lastOutcome, 'interrupt');
      assert.deepEqual(st.pendingTools.map((p) => [p.toolCallId, p.reason]), [['b', 'tool_suspended']]);
    });
  });

  describe('disconnect and dispose', () => {
    it('stream ends without RUN_FINISHED → disconnected; queued follow-ups dropped', async () => {
      const { server, client } = setup(runAndControls({ followUp: (req) => controlResponse(req.body, { accepted: true, queued: 1 }) }));
      void client.send('first');
      await until(() => server.streams.length === 1);
      server.streams[0].send(started(server.requests[0]), { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'half' });
      await until(() => client.getState().status === 'running');
      await client.send('queued');
      server.streams[0].close();
      await client.whenIdle();
      const st = client.getState();
      assert.equal(st.status, 'idle');
      assert.equal(st.lastOutcome, 'disconnected');
      assert.equal(st.error?.kind, 'disconnected');
      assert.equal(users(st)[1].delivery, 'dropped');
      assert.equal((st.items.find((i) => i.kind === 'assistant') as { streaming: boolean }).streaming, false);
      assert.equal(client.isRunOpen, false);
    });

    it('stream read error → disconnected', async () => {
      const { server, client } = setup(runAndControls());
      void client.send('first');
      await until(() => server.streams.length === 1);
      server.streams[0].send(started(server.requests[0]));
      await until(() => client.getState().status === 'running');
      server.streams[0].fail(new Error('socket hang up'));
      await client.whenIdle();
      assert.equal(client.getState().error?.kind, 'disconnected');
      assert.equal(client.getState().status, 'idle');
    });

    it('after a disconnect the next message starts a new run', async () => {
      const { server, client } = setup(runAndControls());
      void client.send('first');
      await until(() => server.streams.length === 1);
      server.streams[0].close();
      await client.whenIdle();
      await client.send('again');
      assert.equal(server.requests[1].action, 'run');
      server.streams[1].send(started(server.requests[1]));
      await until(() => client.getState().status === 'running');
      assert.equal(client.getState().error, null, 'a new run clears the old error');
      server.streams[1].close();
      await client.whenIdle();
    });

    it('dispose closes the open stream (STREAM-1: the endpoint run goes on) and stops updates', async () => {
      const { server, client, states } = setup(runAndControls());
      void client.send('first');
      await until(() => server.streams.length === 1);
      server.streams[0].send(started(server.requests[0]));
      await until(() => client.getState().status === 'running');
      const before = states.length;
      client.dispose();
      assert.equal(server.streams[0].aborted, true);
      server.streams[0].send(...text('m', 'late'));
      await tick(10);
      assert.equal(states.length, before);
      assert.equal((await client.send('x')).ok, false);
      assert.equal(server.requests.length, 1);
    });
  });

  describe('STREAM-1 resume (page shown again / back online)', () => {
    /** The fake endpoint plus GET …/messages answered from `stored` (CHAT-PAGE-1: newest `limit`). */
    function resumable(handler: Parameters<typeof createFakeAguiServer>[0], extra: Partial<ConstructorParameters<typeof AgentChatClient>[0]> = {}) {
      const stored: unknown[] = [];
      let historyCalls = 0;
      const base = setup(handler);
      const server = base.server;
      const fetchImpl = (async (url: string, init: RequestInit) => {
        const u = new URL(String(url), 'http://local');
        if (u.pathname.endsWith('/messages')) {
          historyCalls++;
          const limit = Number(u.searchParams.get('limit') ?? stored.length);
          const page = stored.slice(Math.max(0, stored.length - limit));
          return new Response(JSON.stringify({ messages: page, hasMore: stored.length > page.length }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return server.fetch(url, init);
      }) as unknown as typeof fetch;
      base.client.dispose();
      const client = new AgentChatClient({
        agentId: 'alice',
        threadId: THREAD,
        resourceId: RESOURCE,
        fetch: fetchImpl,
        newId,
        retry: { attempts: 3, delayMs: 5 },
        ...extra,
      });
      return { server, client, stored, historyCalls: () => historyCalls };
    }
    const userMsg = (id: string, text: string) => ({ id, role: 'user', content: { parts: [{ type: 'text', text }] } });
    const assistantMsg = (id: string, text: string) => ({ id, role: 'assistant', content: { parts: [{ type: 'text', text }] } });

    it('run ended while away: history merged (no duplicate user message), settled, disconnected error cleared', async () => {
      const { server, client, stored } = resumable(
        runAndControls({ attach: (req) => controlResponse(req.body, { accepted: false, running: false }) }),
      );
      void client.send('first');
      await until(() => server.streams.length === 1);
      server.streams[0].send(started(server.requests[0]), { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'half' });
      await until(() => assistantText(client.getState()) === 'half');
      server.streams[0].fail(new Error('Load failed')); // iPad Safari suspended the fetch
      await client.whenIdle();
      assert.equal(client.getState().error?.kind, 'disconnected');
      stored.push(userMsg('stored-u1', 'first'), assistantMsg('m', 'half and the rest'), userMsg('stored-u2', 'from another tab'), assistantMsg('m2', 'second answer'));

      const result = await client.resume();
      assert.deepEqual(result, { ok: true, value: { attached: false } });
      const st = client.getState();
      assert.equal(st.error, null);
      assert.equal(st.status, 'idle');
      assert.equal(st.reconnecting, false);
      assert.deepEqual(
        st.items.map((i) => [i.kind, i.id, (i as { text?: string }).text]),
        [
          ['user', 'stored-u1', 'first'],
          ['assistant', 'm', 'half and the rest'],
          ['user', 'stored-u2', 'from another tab'],
          ['assistant', 'm2', 'second answer'],
        ],
      );
      assert.deepEqual(server.requests.map((r) => r.action), ['run', 'attach', 'pending']);
    });

    it('run still going: re-attaches; the replay rebuilds the reply without duplicating it', async () => {
      const { server, client } = resumable((req) => (req.action === 'run' || req.action === 'attach' ? 'stream' : controlResponse(req.body, { accepted: true })));
      void client.send('first');
      await until(() => server.streams.length === 1);
      const run = server.requests[0];
      server.streams[0].send(started(run), { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'half' });
      await until(() => assistantText(client.getState()) === 'half');
      // Stream not errored yet (suspended): resume closes it and attaches again.
      const resuming = client.resume();
      await until(() => server.streams.length === 2);
      assert.equal(server.streams[0].aborted, true, 'the old stream is closed (detach only)');
      assert.equal(client.getState().reconnecting, true);
      server.streams[1].send(
        { type: 'RUN_STARTED', threadId: THREAD, runId: run.body.runId },
        { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'half' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: ' and more' },
      );
      assert.deepEqual(await resuming, { ok: true, value: { attached: true } });
      await until(() => assistantText(client.getState()) === 'half and more');
      server.streams[1].send({ type: 'TEXT_MESSAGE_END', messageId: 'm' }, { type: 'RUN_FINISHED', threadId: THREAD, runId: run.body.runId, outcome: { type: 'success' } });
      server.streams[1].close();
      await client.whenIdle();
      const st = client.getState();
      assert.equal(st.error, null);
      assert.equal(st.lastOutcome, 'success');
      assert.equal(st.reconnecting, false);
      assert.equal(st.items.filter((i) => i.kind === 'assistant').length, 1);
      assert.equal(assistantText(st), 'half and more');
      assert.deepEqual(server.requests.map((r) => r.action), ['run', 'attach']);
    });

    it('concurrent resumes share one catch-up', async () => {
      const { server, client, historyCalls } = resumable(runAndControls({ attach: (req) => controlResponse(req.body, { accepted: false, running: false }) }));
      const [a, b] = [client.resume(), client.resume()];
      assert.equal(a, b);
      await a;
      assert.equal(historyCalls(), 1);
      assert.deepEqual(server.requests.map((r) => r.action), ['attach', 'pending']);
    });

    it('open() re-attaches to a run still going (and skips the pending-cards check)', async () => {
      const { server, client } = resumable((req) => (req.action === 'attach' ? 'stream' : controlResponse(req.body, { accepted: true })));
      assert.equal((await client.open()).ok, true);
      await until(() => server.streams.length === 1);
      server.streams[0].send({ type: 'RUN_STARTED', threadId: THREAD, runId: 'r-open' }, ...text('m', 'still going'));
      await until(() => client.getState().status === 'running');
      server.streams[0].send({ type: 'RUN_FINISHED', threadId: THREAD, runId: 'r-open', outcome: { type: 'success' } });
      server.streams[0].close();
      await client.whenIdle();
      assert.equal(assistantText(client.getState()), 'still going');
      assert.deepEqual(server.requests.map((r) => r.action), ['attach']);
    });

    it('attach answered as a control (no run) is not a run; open() then restores pending cards', async () => {
      const { server, client } = resumable((req) => controlResponse(req.body, { accepted: true }));
      await client.open();
      await until(() => server.requests.length === 2);
      assert.deepEqual(server.requests.map((r) => r.action), ['attach', 'pending']);
      assert.equal(client.getState().status, 'idle');
      assert.equal(client.isRunOpen, false);
    });

    // ---- CHAT-RECONNECT: return from a backgrounded tab with a card waiting / a flaky reconnect ----

    const CARD_ARGS = { question: 'Which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
    const parkedOnCard = { threadId: THREAD, toolCallId: 'card-1', toolName: 'askChoice', label: 'Which?' };
    const pendingCards = (req: FakeRequest) =>
      controlResponse(req.body, {
        accepted: true,
        widgets: [{ toolCallId: 'card-1', toolName: 'askChoice', args: CARD_ARGS }],
        parked: parkedOnCard,
      });

    it('resume after a lost stream restores the parked card and clears the disconnect before resolving', async () => {
      const { server, client, stored } = resumable(
        runAndControls({
          attach: (req) => controlResponse(req.body, { accepted: false, running: true }),
          pending: pendingCards,
        }),
      );
      void client.send('pick a plan');
      await until(() => server.streams.length === 1);
      const req = server.requests[0];
      server.streams[0].send(
        started(req),
        { type: 'TOOL_CALL_START', toolCallId: 'card-1', toolCallName: 'askChoice' },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'card-1', delta: JSON.stringify(CARD_ARGS) },
        { type: 'TOOL_CALL_END', toolCallId: 'card-1' },
        { type: 'CUSTOM', name: 'tourbillon.tool_suspended', value: { toolCallId: 'card-1', toolName: 'askChoice' } },
      ); // the run parks on the card; the tab is backgrounded before the interrupt reaches the client
      await until(() => client.getState().pendingTools.length === 1);
      server.streams[0].fail(new Error('Load failed'));
      await client.whenIdle();
      assert.equal(client.getState().error?.kind, 'disconnected');
      stored.push(userMsg('su', 'pick a plan'));

      const result = await client.resume();
      assert.equal(result.ok, true);
      const st = client.getState();
      assert.equal(st.error, null, 'the disconnect is cleared by the time resume resolves');
      assert.equal(st.status, 'idle');
      assert.equal(st.reconnecting, false);
      assert.deepEqual(st.pendingTools.map((p) => [p.toolCallId, p.reason]), [['card-1', 'tool_suspended']]);
      assert.deepEqual(st.parked, { ...parkedOnCard, elsewhere: false });
      const card = st.items.find((i) => i.kind === 'tool') as Extract<AgentChatItem, { kind: 'tool' }>;
      assert.equal(card.status, 'suspended', 'the card is answerable again');
      assert.deepEqual(server.requests.map((r) => r.action), ['run', 'attach', 'pending']);
    });

    it('an attached stream that dies on a flaky reconnect re-attaches automatically; no sticky disconnect', async () => {
      const { server, client } = resumable(
        (req) => (req.action === 'run' || req.action === 'attach' ? 'stream' : controlResponse(req.body, { accepted: true })),
        { reconnect: { attempts: 3, delayMs: 5 } },
      );
      void client.send('first');
      await until(() => server.streams.length === 1);
      const run = server.requests[0];
      server.streams[0].send(started(run), { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'half' });
      await until(() => client.getState().status === 'running');
      server.streams[0].fail(new Error('Load failed')); // backgrounded before RUN_FINISHED
      await client.whenIdle();
      assert.equal(client.getState().error?.kind, 'disconnected');

      const resuming = client.resume();
      await until(() => server.streams.length === 2);
      server.streams[1].send(started(run), ...text('m', 'half'));
      assert.deepEqual(await resuming, { ok: true, value: { attached: true } });

      server.streams[1].fail(new Error('Load failed')); // the reconnect itself drops (Safari network wake-up)
      const observed: AgentChatState[] = [];
      const un = client.subscribe(() => observed.push(client.getState()));
      await until(() => server.requests.filter((r) => r.action === 'attach').length === 2, 2000, 'automatic second attach');
      un();
      assert.ok(!observed.some((s) => s.error?.kind === 'disconnected'), 'no sticky disconnect while reconnecting');
      assert.ok(observed.some((s) => s.reconnecting === true), 'the client shows it is catching up');
      server.streams[2].send(started(run), ...text('m', 'half the whole'));
      await until(() => assistantText(client.getState()) === 'half the whole', 2000, 'live events after re-attach');
      server.streams[2].send({ type: 'RUN_FINISHED', threadId: THREAD, runId: run.body.runId, outcome: { type: 'success' } });
      server.streams[2].close();
      await client.whenIdle();
      assert.equal(client.getState().error, null);
      assert.equal(client.getState().reconnecting, false);
      assert.equal(assistantText(client.getState()), 'half the whole');
      assert.equal(server.requests.filter((r) => r.action === 'run').length, 1, 'the run was re-attached, never restarted');
    });

    it('a re-attached stream that keeps dying reports the lost connection once the budget is spent', async () => {
      const { server, client } = resumable(
        (req) => (req.action === 'run' || req.action === 'attach' ? 'stream' : controlResponse(req.body, { accepted: true })),
        { reconnect: { attempts: 2, delayMs: 5 } },
      );
      void client.send('first');
      await until(() => server.streams.length === 1);
      const run = server.requests[0];
      server.streams[0].send(started(run), ...text('m', 'x'));
      await until(() => client.getState().status === 'running');
      server.streams[0].fail(new Error('Load failed'));
      await client.whenIdle();
      const resuming = client.resume();
      for (const n of [1, 2, 3]) {
        await until(() => server.streams.length === n + 1, 2000, `attach stream ${n}`);
        server.streams[n].send(started(run), ...text('m', 'x'));
        server.streams[n].fail(new Error('Load failed'));
        if (n === 1) await resuming;
      }
      await until(() => client.getState().error?.kind === 'disconnected', 2000, 'the disconnect is reported after retries');
      assert.equal(server.requests.filter((r) => r.action === 'attach').length, 3, 'one attach plus two retries');
      // A later page-resume style resume gets a fresh budget.
      const again = client.resume();
      await until(() => server.requests.filter((r) => r.action === 'attach').length === 4, 2000, 'resume after the budget spends re-attaches again');
      server.streams[4].send(started(run), ...text('m', 'x'));
      server.streams[4].send(finished(run));
      server.streams[4].close();
      assert.equal((await again).ok, true);
      await client.whenIdle();
      assert.equal(client.getState().error, null);
      assert.equal(client.getState().lastOutcome, 'success');
    });

    // ---- CHAT-RECONNECT softs: retry-budget bookkeeping, reconnecting chrome, attach-death edges ----

    /**
     * Attach answers scripted per call (1-based); every attach reply is scripted, controls default
     * to accepted. `runAnswer` overrides the `run` reply (default: an open stream).
     */
    function budgeted(
      attachAnswer: (n: number, req: FakeRequest) => Answer,
      extra: Partial<ConstructorParameters<typeof AgentChatClient>[0]> = {},
      runAnswer: (req: FakeRequest) => Answer = () => 'stream',
    ) {
      let attaches = 0;
      const world = resumable((req) => {
        if (req.action === 'attach') return attachAnswer(++attaches, req);
        if (req.action === 'run') return runAnswer(req);
        return controlResponse(req.body, { accepted: true });
      }, extra);
      const attachCount = () => world.server.requests.filter((r) => r.action === 'attach').length;
      return { ...world, attachCount };
    }
    const attachReqs = (server: { requests: FakeRequest[] }) => server.requests.filter((r) => r.action === 'attach');
    /** Makes attach `attachIdx` (0-based) a live run on stream `streamIdx` (decision: run). */
    const bringUp = (server: { requests: FakeRequest[]; streams: OpenStream[] }, streamIdx: number, attachIdx: number) => {
      const req = attachReqs(server)[attachIdx];
      server.streams[streamIdx].send(
        { type: 'RUN_STARTED', threadId: THREAD, runId: req.body.runId },
        { type: 'TEXT_MESSAGE_START', messageId: `m-${attachIdx}`, role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: `m-${attachIdx}`, delta: 'live' },
      );
    };
    /**
     * Script live events and wait until the client has adopted the attach as its open run: the fake
     * stream delivers queued chunks once the reader is waiting, and adoption is the proof the client
     * processed them (a `fail()` before that would wipe the unread chunk instead of dropping a live run).
     */
    const liveAttach = async (
      client: AgentChatClient,
      server: { requests: FakeRequest[]; streams: OpenStream[] },
      streamIdx: number,
      attachIdx: number,
    ) => {
      // requests are recorded before the handler answers — wait for this attach's stream to exist.
      await until(() => server.streams.length > streamIdx, 2000, `stream for attach #${attachIdx + 1}`);
      bringUp(server, streamIdx, attachIdx);
      await until(() => client.isRunOpen, 2000, `attach #${attachIdx + 1} adopted as the open run`);
    };
    const finishAttach = (server: { requests: FakeRequest[]; streams: OpenStream[] }, streamIdx: number, attachIdx: number) => {
      const req = attachReqs(server)[attachIdx];
      server.streams[streamIdx].send({ type: 'RUN_FINISHED', threadId: THREAD, runId: req.body.runId, outcome: { type: 'success' } });
      server.streams[streamIdx].close();
    };

    describe('re-attach budget bookkeeping', () => {
      it('a run that finishes over an attached stream renews the budget so a later drop re-attaches again', async () => {
        const { server, client, attachCount } = budgeted(() => 'stream', { reconnect: { attempts: 1, delayMs: 5 } });
        await client.open(); // attach #1 (open() does not touch the budget)
        await until(() => server.streams.length === 1, 2000, 'attach #1');
        await liveAttach(client, server, 0, 0);
        server.streams[0].fail(new Error('dropped'));
        await until(() => attachCount() === 2, 2000, 'the one automatic retry');
        await liveAttach(client, server, 1, 1);
        finishAttach(server, 1, 1); // RUN_FINISHED over the attached stream: the budget is whole again
        await client.whenIdle();
        await client.open(); // attach #3: a fresh drop must still get its full budget
        await until(() => attachCount() === 3, 2000, 'attach #3');
        await liveAttach(client, server, 2, 2);
        server.streams[2].fail(new Error('dropped'));
        await until(() => attachCount() === 4, 2000, 'retry available after the finished run');
        await liveAttach(client, server, 3, 3);
        finishAttach(server, 3, 3);
        await client.whenIdle();
        client.dispose();
      });

      it('a run that errors over an attached stream renews the budget without a lost-connection report', async () => {
        const { server, client, attachCount } = budgeted(() => 'stream', { reconnect: { attempts: 1, delayMs: 5 } });
        await client.open();
        await until(() => server.streams.length === 1, 2000, 'attach #1');
        await liveAttach(client, server, 0, 0);
        server.streams[0].fail(new Error('dropped'));
        await until(() => attachCount() === 2, 2000, 'the one automatic retry');
        await liveAttach(client, server, 1, 1);
        server.streams[1].send({ type: 'RUN_ERROR', message: 'agent exploded' });
        server.streams[1].close();
        await client.whenIdle();
        assert.equal(client.getState().error?.kind, 'run', 'the run error is what is shown, not a lost connection');
        await client.open();
        await until(() => attachCount() === 3, 2000, 'attach #3');
        await liveAttach(client, server, 2, 2);
        server.streams[2].fail(new Error('dropped'));
        await until(() => attachCount() === 4, 2000, 'retry available after the errored run');
        await liveAttach(client, server, 3, 3);
        finishAttach(server, 3, 3);
        await client.whenIdle();
        client.dispose();
      });

      it('a user-initiated send renews the budget for the next dropped attach', async () => {
        const { server, client, attachCount } = budgeted(
          (n, req) => (n === 2 ? controlResponse(req.body, { accepted: false, running: false }) : 'stream'),
          { reconnect: { attempts: 1, delayMs: 40 } },
          () => jsonError(409, 'A run is already in progress; send steer or followUp instead'),
        );
        await client.open();
        await until(() => server.streams.length === 1, 2000, 'attach #1');
        await liveAttach(client, server, 0, 0);
        server.streams[0].fail(new Error('dropped')); // one loss burned, retry timer pending
        await until(() => !client.isRunOpen, 2000, 'the dead stream is released');
        const sent = await client.send('user takes over'); // resets the budget; refused 409 (no stream, no terminal)
        if (sent.ok) assert.fail('expected the run to be refused');
        assert.equal(sent.error.kind, 'conflict');
        await tick(120); // the pending retry stands down (idle here) and shares the reset budget
        await client.open();
        await until(() => attachCount() === 3, 2000, 'attach #3');
        await liveAttach(client, server, 1, 2);
        server.streams[1].fail(new Error('dropped'));
        await until(() => attachCount() === 4, 2000, 'retry available after the send');
        await liveAttach(client, server, 2, 3);
        finishAttach(server, 2, 3);
        await client.whenIdle();
        client.dispose();
      });

      it('a page resume mid-cycle restarts the budget so the full retry count is available again', async () => {
        const { server, client, attachCount } = budgeted(() => 'stream', { reconnect: { attempts: 2, delayMs: 5 } });
        await client.open();
        await until(() => server.streams.length === 1, 2000, 'attach #1');
        await liveAttach(client, server, 0, 0);
        server.streams[0].fail(new Error('dropped')); // 1 of 2 burned
        await until(() => attachCount() === 2, 2000, 'retry #2');
        await liveAttach(client, server, 1, 1);
        const resuming = client.resume(); // page came back: fresh budget, closes #2 and attaches #3
        await liveAttach(client, server, 2, 2);
        assert.deepEqual(await resuming, { ok: true, value: { attached: true } });
        assert.equal(attachCount(), 3);
        server.streams[2].fail(new Error('dropped')); // burn #1 of the fresh budget
        await until(() => attachCount() === 4, 2000, 'retry 1 of the fresh budget');
        await liveAttach(client, server, 3, 3);
        server.streams[3].fail(new Error('dropped')); // burn #2
        await until(() => attachCount() === 5, 2500, 'retry 2 of the fresh budget (only a resume reset makes 5 possible)');
        assert.notEqual(client.getState().error?.kind, 'disconnected', 'the budget was not spent yet');
        await liveAttach(client, server, 4, 4);
        finishAttach(server, 4, 4);
        await client.whenIdle();
        client.dispose();
      });

      it('the default budget is 3 growing retries at the 500ms base delay before reporting a lost connection', async () => {
        const { server, client, attachCount } = budgeted(() => 'stream'); // no reconnect option: defaults
        await client.open();
        await until(() => server.streams.length === 1, 2000, 'attach #1');
        await liveAttach(client, server, 0, 0);
        const t1 = Date.now();
        server.streams[0].fail(new Error('dropped'));
        await tick(250);
        assert.equal(attachCount(), 1, 'no retry before the base delay (default delayMs 500)');
        await until(() => attachCount() === 2, 3000, 'retry 1');
        const gap1 = Date.now() - t1;
        await liveAttach(client, server, 1, 1);
        server.streams[1].fail(new Error('dropped'));
        const t2 = Date.now();
        await until(() => attachCount() === 3, 5000, 'retry 2');
        const gap2 = Date.now() - t2;
        await liveAttach(client, server, 2, 2);
        server.streams[2].fail(new Error('dropped'));
        const t3 = Date.now();
        await until(() => attachCount() === 4, 6000, 'retry 3');
        const gap3 = Date.now() - t3;
        await liveAttach(client, server, 3, 3);
        server.streams[3].fail(new Error('dropped'));
        await until(() => client.getState().error?.kind === 'disconnected', 3000, 'lost connection after the default budget');
        assert.equal(attachCount(), 4, 'one attach plus the three default retries');
        assert.ok(gap1 >= 300, `first wait near the base delay (was ${gap1}ms)`);
        assert.ok(gap2 >= 700, `second wait grows, delayMs x losses (was ${gap2}ms)`);
        assert.ok(gap3 >= 1100, `third wait grows further (was ${gap3}ms)`);
        assert.ok(gap2 > gap1 && gap3 > gap2, 'linear, growing backoff');
        client.dispose();
      });
    });

    describe('reconnecting chrome', () => {
      it('a dropped attached stream shows the reconnecting chrome while the retry timer is still pending', async () => {
        const { server, client, attachCount } = budgeted(() => 'stream', { reconnect: { attempts: 3, delayMs: 400 } });
        await client.open();
        await until(() => server.streams.length === 1, 2000, 'attach #1');
        await liveAttach(client, server, 0, 0);
        server.streams[0].fail(new Error('dropped'));
        await until(() => client.getState().reconnecting === true, 200, 'the flag is set when the stream dies');
        assert.equal(attachCount(), 1, 'set by the stream-end handling itself, before the timer fires');
        assert.notEqual(client.getState().error?.kind, 'disconnected', 'no disconnect shown while the budget has retries left');
        await until(() => attachCount() === 2, 3000, 'the scheduled retry attaches');
        await liveAttach(client, server, 1, 1);
        finishAttach(server, 1, 1);
        await client.whenIdle();
        assert.equal(client.getState().reconnecting, false);
        client.dispose();
      });

      it('a retry scheduled before dispose never fires after it', async () => {
        const { server, client, attachCount } = budgeted(() => 'stream', { reconnect: { attempts: 3, delayMs: 150 } });
        await client.open();
        await until(() => server.streams.length === 1, 2000, 'attach #1');
        await liveAttach(client, server, 0, 0);
        server.streams[0].fail(new Error('dropped'));
        await until(() => client.getState().reconnecting === true, 200, 'retry pending');
        client.dispose();
        await tick(350); // past the scheduled retry delay
        assert.equal(attachCount(), 1, 'the pending timer is gone and the disposed client re-attaches to nothing');
        assert.equal((await client.resume()).ok, false, 'a disposed client does not resume');
      });

      it('a user run started while the retry timer is pending clears the chrome and stands the retry down', async () => {
        const { server, client, attachCount } = budgeted(() => 'stream', { reconnect: { attempts: 3, delayMs: 60 } });
        await client.open();
        await until(() => server.streams.length === 1, 2000, 'attach #1');
        await liveAttach(client, server, 0, 0);
        server.streams[0].fail(new Error('dropped'));
        await until(() => client.getState().reconnecting === true, 200, 'retry pending');
        const sending = client.send('user takes over now');
        await until(() => server.requests.some((r) => r.action === 'run'), 2000, 'run request');
        await sending;
        await tick(150); // past the timer: a run is open here, so the retry must stand down
        assert.equal(attachCount(), 1, 'no re-attach: this client owns the run now');
        assert.equal(client.getState().reconnecting, false, 'the chrome is cleared by the stand-down');
        const runReq = server.requests.find((r) => r.action === 'run')!;
        server.streams[1].send(
          { type: 'RUN_STARTED', threadId: THREAD, runId: runReq.body.runId },
          { type: 'RUN_FINISHED', threadId: THREAD, runId: runReq.body.runId, outcome: { type: 'success' } },
        );
        server.streams[1].close();
        await client.whenIdle();
        client.dispose();
      });

      it('dispose cancels the pending retry timer: a disposed client stays silent past the retry delay', async () => {
        // S253-S1: the sibling pin above cannot see `clearTimeout` being dropped — the timer
        // callback, `doResume` and `attachOpenRun` each re-check `disposed`, so any one of them
        // masks it. This variant makes dispose's cancellation the load-bearing defence: with the
        // redundant `disposed` guards stripped (mutant verified RED: a second attach request is
        // recorded), a timer that survived dispose would re-attach. Past the delay, the disposed
        // client must have touched the endpoint zero times and must not be resuming.
        const { server, client, attachCount } = budgeted(() => 'stream', { reconnect: { attempts: 3, delayMs: 120 } });
        await client.open();
        await until(() => server.streams.length === 1, 2000, 'attach #1');
        await liveAttach(client, server, 0, 0);
        server.streams[0].fail(new Error('dropped'));
        await until(() => client.getState().reconnecting === true, 200, 'retry pending');
        const requestsAtDispose = server.requests.length;
        client.dispose();
        await tick(400); // comfortably past the scheduled retry delay
        assert.equal(attachCount(), 1, 'the cancelled timer never reaches the endpoint');
        assert.equal(server.requests.length, requestsAtDispose, 'a disposed client sends no request at all');
        assert.equal(client.getState().reconnecting, true, 'dispose does not rewrite the last shown state');
        assert.equal((await client.resume()).ok, false, 'and the disposed client still refuses to resume');
      });
    });

    describe('dispose timer cancellation (source pin)', () => {
      // S253-S1: the behaviour side is masked by redundant `disposed` guards, so pin the
      // cancellation itself: the dispose body must cancel the pending retry timer AND drop the
      // handle (the `doResume` finally treats a set handle as "retry pending" — a stale one would
      // keep the chrome alive). Mutants verified RED: drop the clearTimeout line, drop the
      // handle reset (each fails one assertion).
      const src = readFileSync(join(__dirname, 'agent-chat-client.ts'), 'utf8');
      const disposeBody = src.slice(src.indexOf('dispose(): void {'), src.indexOf('// ---- internals ----'));

      it('dispose clears the pending reconnect timer and drops its handle', () => {
        assert.match(disposeBody, /if\s*\(this\.reconnectTimer\)\s*clearTimeout\(this\.reconnectTimer\);/);
        assert.match(disposeBody, /this\.reconnectTimer\s*=\s*undefined;/);
      });
    });

    describe('attached death around an in-flight resume', () => {
      it('an attached stream dying just after adoption keeps the chrome up while the retry timer is pending', async () => {
        const { server, client, attachCount } = budgeted(() => 'stream', { reconnect: { attempts: 3, delayMs: 5 } });
        await client.open();
        await until(() => server.streams.length === 1, 2000, 'attach #1');
        await liveAttach(client, server, 0, 0);
        server.streams[0].fail(new Error('dropped'));
        await until(() => attachCount() === 2, 2000, 'retry attach #2');
        // The retry's attach is adopted (its resume is completing) and the stream drops right after:
        // the budget is burned and the timer armed around the resume settling — the chrome must be up
        // for the whole gap until the next attach lands (no window with neither flag nor disconnect).
        await liveAttach(client, server, 1, 1);
        server.streams[1].fail(new Error('dropped'));
        await until(() => !client.isRunOpen, 2000, 'the dead retry attach is released');
        assert.equal(client.getState().reconnecting, true, 'chrome stays up while the retry timer is pending');
        assert.notEqual(client.getState().error?.kind, 'disconnected');
        await until(() => attachCount() === 3, 2000, 'the armed retry still attaches');
        await liveAttach(client, server, 2, 2);
        finishAttach(server, 2, 2);
        await client.whenIdle();
        assert.equal(client.getState().reconnecting, false, 'the successful attach clears the chrome');
        assert.equal(client.getState().error, null);
        client.dispose();
      });

      it('a retry that fires while a resume is in flight joins it instead of attaching a second time', async () => {
        const server = createFakeAguiServer((req) =>
          req.action === 'attach' ? 'stream' : controlResponse(req.body, { accepted: true }),
        );
        let hold: Promise<void> | null = null;
        const fetchImpl = (async (url: string, init: RequestInit) => {
          if (/\/messages(\?|$)/.test(String(url))) {
            if (hold) await hold;
            return new Response(JSON.stringify({ messages: [], hasMore: false }), { headers: { 'Content-Type': 'application/json' } });
          }
          return server.fetch(url, init);
        }) as unknown as typeof fetch;
        const client = new AgentChatClient({
          agentId: 'alice',
          threadId: THREAD,
          resourceId: RESOURCE,
          fetch: fetchImpl,
          newId,
          retry: { attempts: 3, delayMs: 5 },
          reconnect: { attempts: 3, delayMs: 8 },
        });
        await client.open();
        await until(() => server.streams.length === 1, 2000, 'attach #1');
        await liveAttach(client, server, 0, 0);
        server.streams[0].fail(new Error('dropped')); // burn 1, retry timer armed for 8ms
        await until(() => client.getState().reconnecting === true, 200, 'retry pending');
        let release!: () => void;
        hold = new Promise<void>((r) => (release = r));
        const resuming = client.resume(); // in flight (history held) when the timer fires
        await tick(40); // past the retry delay: it must join the in-flight resume, not attach again
        assert.equal(server.requests.filter((r) => r.action === 'attach').length, 1, 'the fired retry joined the in-flight resume');
        assert.equal(client.getState().reconnecting, true, 'the chrome covers the joined wait');
        release();
        await until(() => server.requests.filter((r) => r.action === 'attach').length === 2, 2000, 'the resumed cycle attaches');
        assert.equal(server.requests.filter((r) => r.action === 'attach').length, 2, 'one attach for the joined cycle');
        await liveAttach(client, server, 1, 1);
        const result = await resuming;
        assert.equal(result.ok, true);
        assert.notEqual(client.getState().error?.kind, 'disconnected');
        server.streams[1].fail(new Error('dropped'));
        await until(() => server.requests.filter((r) => r.action === 'attach').length === 3, 2000, 'the next drop still re-attaches');
        await liveAttach(client, server, 2, 2);
        finishAttach(server, 2, 2);
        await client.whenIdle();
        assert.equal(client.getState().reconnecting, false);
        client.dispose();
      });
    });
  });

  describe('request defaults', () => {
    it('sends empty tools and context unless tools are given; given tools are sent as-is', () => {
      const plain = new AgentChatClient({ agentId: 'alice', threadId: THREAD, newId });
      const input = plain.buildInput('run', 'hi');
      assert.deepEqual(input.tools, []);
      assert.deepEqual(input.context, []);
      assert.deepEqual(input.forwardedProps.tourbillon, { action: 'run' });
      const tools = [{ name: 'pick', description: 'Pick one', parameters: { type: 'object' } }];
      const withTools = new AgentChatClient({ agentId: 'alice', threadId: THREAD, newId, tools });
      assert.deepEqual(withTools.buildInput('followUp', 'x').tools, tools);
      assert.deepEqual(withTools.buildInput('followUp', 'x').context, []);
    });

    it('UI-3: a message can carry page context (overrides the client context); the endpoint accepts it', async () => {
      const ctx = { contextType: 'issue' as const, contextId: 'i-1', contextTitle: 'Fix login' };
      const client = new AgentChatClient({ agentId: 'alice', threadId: THREAD, newId, context: { contextType: 'free' } });
      assert.deepEqual(client.buildInput('run', 'hi').forwardedProps.tourbillon, { action: 'run', context: { contextType: 'free' } });
      const { server, client: c2 } = setup(runAndControls());
      await c2.send('about this', { context: ctx });
      await until(() => server.requests.length === 1);
      assert.deepEqual(server.requests[0].body.forwardedProps.tourbillon.context, ctx);
      assert.deepEqual(parseAguiRequest(server.requests[0].body).context, ctx);
      server.streams[0].send(started(server.requests[0]), ...text('m1', 'ok'));
      await c2.send('follow up');
      await until(() => server.requests.length === 2);
      assert.equal(server.requests[1].action, 'followUp');
      assert.equal(server.requests[1].body.forwardedProps.tourbillon.context, undefined);
      c2.dispose();
    });

    it('a run refused with 409 "retry shortly" is not retried (only control actions are)', async () => {
      const { server, client } = setup(() => jsonError(409, 'A run is starting on this thread; retry shortly'));
      const r = await client.send('hello');
      assert.equal(r.ok, false);
      assert.equal(server.requests.length, 1);
      assert.equal(client.getState().error?.kind, 'conflict');
      assert.deepEqual(users(client.getState()).map((u) => u.delivery), ['failed']);
    });
  });

  describe('runs ending without the user asking', () => {
    it('cancelled while the user did not press Stop → "run cancelled" is shown', async () => {
      const { server, client } = setup(runAndControls());
      void client.send('long task');
      await until(() => server.streams.length === 1);
      const req = server.requests[0];
      server.streams[0].send(started(req), ...text('m', 'partial'), finished(req, 'cancelled'));
      server.streams[0].close();
      await client.whenIdle();
      const st = client.getState();
      assert.equal(st.lastOutcome, 'cancelled');
      assert.equal(st.status, 'idle');
      assert.equal(st.error?.kind, 'cancelled');
      assert.match(st.error!.message, /Run cancelled/);
    });

    it('cancelled after the user pressed Stop → no message, and an earlier error is cleared', async () => {
      const { server, client } = setup(runAndControls({ steer: () => jsonError(409, 'Refused for this test') }));
      void client.send('long task');
      await until(() => server.streams.length === 1);
      const req = server.requests[0];
      server.streams[0].send(started(req));
      await until(() => client.getState().status === 'running');
      // A stale error from an earlier action (a refused steer) is on screen.
      assert.equal((await client.steer('shorter')).ok, false);
      assert.equal(client.getState().error?.kind, 'conflict');
      const stopping = client.abort();
      await until(() => server.requests.some((q) => q.action === 'abort'));
      server.streams[0].send(finished(req, 'cancelled'));
      server.streams[0].close();
      await stopping;
      await client.whenIdle();
      const st = client.getState();
      assert.equal(st.lastOutcome, 'cancelled');
      assert.equal(st.error, null);
    });
  });

  describe('tool approval after an interrupt', () => {
    async function interrupted(results: Array<{ toolCallId: string; accepted: boolean; reason?: string }>, accepted = true) {
      const ctx = setup(
        runAndControls({
          toolApproval: (req) => controlResponse(req.body, { accepted, toolCallIds: results.map((r) => r.toolCallId), results }),
        }),
      );
      void ctx.client.send('do it');
      await until(() => ctx.server.streams.length === 1);
      const req = ctx.server.requests[0];
      ctx.server.streams[0].send(
        started(req),
        { type: 'TOOL_CALL_START', toolCallId: 'call-1', toolCallName: 'deleteThing' },
        { type: 'TOOL_CALL_END', toolCallId: 'call-1' },
        { type: 'CUSTOM', name: 'tourbillon.tool_approval_required', value: { toolCallId: 'call-1', toolName: 'deleteThing' } },
        finished(req, 'interrupt'),
      );
      ctx.server.streams[0].close();
      await ctx.client.whenIdle();
      assert.equal(ctx.client.getState().lastOutcome, 'interrupt');
      assert.equal(ctx.client.getState().pendingTools.length, 1);
      return ctx;
    }
    const toolStatus = (st: AgentChatState) => (st.items.find((i) => i.kind === 'tool') as { status: string }).status;

    it('approve accepted with no run open → the tool is not shown as running and a message explains why', async () => {
      const { client } = await interrupted([{ toolCallId: 'call-1', accepted: true }]);
      const r = await client.respondToTool('call-1', true);
      assert.equal(r.ok, true);
      const st = client.getState();
      assert.equal(st.status, 'idle');
      assert.equal(toolStatus(st), 'detached');
      assert.deepEqual(st.pendingTools, []);
      assert.equal(st.error?.kind, 'detached');
      assert.match(st.error!.message, /no longer connected to the run/);
    });

    it('decline accepted with no run open → denied, no message', async () => {
      const { client } = await interrupted([{ toolCallId: 'call-1', accepted: true }]);
      assert.equal((await client.respondToTool('call-1', false)).ok, true);
      assert.equal(toolStatus(client.getState()), 'denied');
      assert.equal(client.getState().error, null);
    });

    it('a per-tool rejection inside an accepted approval is reported; the tool stays pending', async () => {
      const { client } = await interrupted(
        [
          { toolCallId: 'other', accepted: true },
          { toolCallId: 'call-1', accepted: false, reason: 'not_pending' },
        ],
        true,
      );
      const r = await client.respondToTool('call-1', true);
      assert.equal(r.ok, false);
      const st = client.getState();
      assert.deepEqual(st.error, { kind: 'rejected', message: 'Tool decision not applied (not_pending)' });
      assert.equal(st.pendingTools.length, 1);
      assert.equal(toolStatus(st), 'awaiting_approval');
    });
  });

  it('an empty message is not sent', async () => {
    const { server, client } = setup(runAndControls());
    assert.equal((await client.send('   ')).ok, false);
    assert.equal(server.requests.length, 0);
  });
});
