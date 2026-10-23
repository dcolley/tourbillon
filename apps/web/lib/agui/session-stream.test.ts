/**
 * AGUI-1: AG-UI run stream over a real AgentController session (in-memory storage, stub model),
 * consumed by the official AG-UI HttpAgent client, which validates the event sequence.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpAgent } from '@ag-ui/client';
import type { BaseEvent, Message } from '@ag-ui/core';
import {
  AGUI_SSE_HEADERS,
  aguiControlStream,
  aguiRunStream,
  expectRunContinuation,
  type AguiSession,
  type AguiThreadQueue,
} from './session-stream';
import {
  createStubAgentController,
  stubText,
  stubToolCall,
  type StubAgentController,
} from './testing/stub-agent-controller';

const RESOURCE = 'company-c1:chat:free';
type Session = Awaited<ReturnType<StubAgentController['createSession']>>;
type Ev = BaseEvent & Record<string, any>;

/** Runs one AG-UI turn through HttpAgent; `send` starts the Mastra turn on the session. */
async function runTurn(
  session: Session,
  opts: {
    send: () => Promise<void>;
    onEvent?: (event: Ev, agent: HttpAgent) => void;
    heartbeatMs?: number;
  },
) {
  const threadId = session.thread.getId() ?? 'thread';
  const events: Ev[] = [];
  const agent = new HttpAgent({
    url: 'http://agui.test/run',
    threadId,
    initialMessages: [{ id: 'u1', role: 'user', content: 'hi' }],
    fetch: async (_url, init) =>
      new Response(
        aguiRunStream({
          session: session as unknown as AguiSession,
          threadId,
          runId: 'run-1',
          mastraThreadId: threadId,
          resourceId: RESOURCE,
          signal: init.signal ?? undefined,
          start: opts.send,
          heartbeatMs: opts.heartbeatMs,
        }),
        { headers: AGUI_SSE_HEADERS },
      ),
  });
  let failure: unknown;
  const result = await agent
    .runAgent(
      { runId: 'run-1' },
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
      return undefined;
    });
  return { events, result, failure, messages: agent.messages as Message[] };
}

const types = (events: Ev[]) => events.map((e) => e.type);
const text = (events: Ev[]) =>
  events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta as string).join('');

async function waitFor(check: () => boolean, ms = 5000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('AGUI-1 run stream on a real session (stub model)', () => {
  it('text + one tool call: client receives tool call, result, text and RUN_FINISHED', async () => {
    const executed: unknown[] = [];
    const stub = await createStubAgentController({
      script: (_call, prompt) =>
        prompt.some((m) => m.role === 'tool')
          ? stubText('t1', ['Hello ', 'there'])
          : stubToolCall('call-1', 'echo', { text: 'hi' }),
      tools: {
        echo: (input: { text: string }) => {
          executed.push(input);
          return { echoed: input.text };
        },
      },
    });
    const session = await stub.createSession(RESOURCE, 'agui');
    const sessionToolNames: string[] = [];
    session.subscribe((e: any) => {
      if (e.type === 'tool_start') sessionToolNames.push(e.toolName);
    });

    const { events, failure, messages } = await runTurn(session, {
      send: () => session.sendMessage({ content: 'please echo hi' }),
    });

    assert.equal(failure, undefined);
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
    assert.equal(text(events), 'Hello there');
    assert.deepEqual(executed, [{ text: 'hi' }]);
    const start = events.find((e) => e.type === 'TOOL_CALL_START')!;
    // Tool-id parity: the AG-UI tool name is the agent's registered tool id, as the session reports it.
    assert.equal(start.toolCallName, 'echo');
    assert.deepEqual(sessionToolNames, ['echo']);
    assert.equal(events.find((e) => e.type === 'TOOL_CALL_RESULT')!.content, '{"echoed":"hi"}');
    assert.deepEqual(events.at(-1)!.outcome, { type: 'success' });
    // The client assembled the turn: an assistant message with the tool call and the text.
    const assistant = messages.filter((m) => m.role === 'assistant');
    assert.ok(assistant.some((m) => (m as { toolCalls?: Array<{ function: { name: string } }> }).toolCalls?.[0]?.function.name === 'echo'));
    assert.ok(assistant.some((m) => m.content === 'Hello there'));
  });

  it('client abortRun() aborts the session run', async () => {
    const stub = await createStubAgentController({
      script: () => stubText('t1', Array.from({ length: 40 }, (_, i) => `w${i} `)),
      chunkDelayMs: 20,
    });
    const session = await stub.createSession(RESOURCE, 'agui');
    const ends: string[] = [];
    session.subscribe((e: any) => {
      if (e.type === 'agent_end') ends.push(e.reason ?? '');
    });
    let aborted = false;
    await runTurn(session, {
      send: () => session.sendMessage({ content: 'long answer' }),
      onEvent: (event, agent) => {
        if (event.type === 'TEXT_MESSAGE_CONTENT' && !aborted) {
          aborted = true;
          agent.abortRun();
        }
      },
    });
    await waitFor(() => ends.length > 0);
    assert.deepEqual(ends, ['aborted']);
    assert.equal(session.getCurrentRunId() ?? null, null);
  });

  it('abort from another request ends the open run as cancelled', async () => {
    const stub = await createStubAgentController({
      script: () => stubText('t1', Array.from({ length: 40 }, (_, i) => `w${i} `)),
      chunkDelayMs: 20,
    });
    const session = await stub.createSession(RESOURCE, 'agui');
    let sent = false;
    const { events, failure } = await runTurn(session, {
      send: () => session.sendMessage({ content: 'long answer' }),
      onEvent: (event) => {
        if (event.type === 'TEXT_MESSAGE_CONTENT' && !sent) {
          sent = true;
          session.abort();
        }
      },
    });
    assert.equal(failure, undefined);
    assert.equal(types(events).filter((t) => t === 'RUN_FINISHED').length, 1);
    assert.deepEqual(events.at(-1)!.outcome, { type: 'cancelled' });
    assert.equal(types(events).filter((t) => t === 'TEXT_MESSAGE_START').length, types(events).filter((t) => t === 'TEXT_MESSAGE_END').length);
  });

  it('steer mid-run: same AG-UI run continues with the steered reply', async () => {
    const stub = await createStubAgentController({
      script: (call) =>
        call === 1 ? stubText('t1', Array.from({ length: 40 }, (_, i) => `w${i} `)) : stubText('t2', ['steered']),
      chunkDelayMs: 20,
    });
    const session = await stub.createSession(RESOURCE, 'agui');
    let steered = false;
    const { events, failure } = await runTurn(session, {
      send: () => session.sendMessage({ content: 'first' }),
      onEvent: (event) => {
        if (event.type === 'TEXT_MESSAGE_CONTENT' && !steered) {
          steered = true;
          expectRunContinuation(session);
          void session.steer({ content: 'change of plan' });
        }
      },
    });
    assert.equal(failure, undefined);
    assert.equal(types(events).filter((t) => t === 'RUN_STARTED').length, 1);
    assert.equal(types(events).filter((t) => t === 'RUN_FINISHED').length, 1);
    assert.ok(text(events).endsWith('steered'));
    assert.deepEqual(events.at(-1)!.outcome, { type: 'success' });
    assert.equal(stub.modelCalls, 2);
    assert.match(JSON.stringify(stub.prompts[1]), /change of plan/);
  });

  it('follow-up mid-run: queued turn streams in the same AG-UI run', async () => {
    const stub = await createStubAgentController({
      script: (call) => (call === 1 ? stubText('t1', ['one ', 'two ', 'three ']) : stubText('t2', ['followed'])),
      chunkDelayMs: 30,
    });
    const session = await stub.createSession(RESOURCE, 'agui');
    let queued = false;
    const { events, failure } = await runTurn(session, {
      send: () => session.sendMessage({ content: 'first' }),
      onEvent: (event) => {
        if (event.type === 'TEXT_MESSAGE_CONTENT' && !queued) {
          queued = true;
          void session.followUp({ content: 'and another thing' });
        }
      },
    });
    assert.equal(failure, undefined);
    assert.equal(types(events).filter((t) => t === 'RUN_FINISHED').length, 1);
    assert.equal(text(events), 'one two three followed');
    assert.ok(events.some((e) => e.type === 'CUSTOM' && e.name === 'tourbillon.follow_up_queued'));
    assert.match(JSON.stringify(stub.prompts[1]), /and another thing/);
  });

  it('SSE keep-alive comments are ignored by the client', async () => {
    const stub = await createStubAgentController({ script: () => stubText('t1', ['a', 'b', 'c']), chunkDelayMs: 40 });
    const session = await stub.createSession(RESOURCE, 'agui');
    const { events, failure } = await runTurn(session, {
      send: () => session.sendMessage({ content: 'hi' }),
      heartbeatMs: 10,
    });
    assert.equal(failure, undefined);
    assert.equal(text(events), 'abc');
  });

  it('a failed start ends the run with RUN_ERROR', async () => {
    const stub = await createStubAgentController({ script: () => stubText('t1', ['x']) });
    const session = await stub.createSession(RESOURCE, 'agui');
    const { events } = await runTurn(session, { send: () => Promise.reject(new Error('could not start')) });
    assert.deepEqual(types(events), ['RUN_STARTED', 'RUN_ERROR']);
    assert.equal(events[1].message, 'could not start');
  });

  it('control stream is a complete, valid AG-UI run', async () => {
    const agent = new HttpAgent({
      url: 'http://agui.test/run',
      threadId: 'th',
      fetch: async () =>
        new Response(
          aguiControlStream({
            threadId: 'th',
            runId: 'r',
            events: [{ type: 'CUSTOM', name: 'tourbillon.control', value: { action: 'abort', accepted: true } } as BaseEvent],
          }),
          { headers: AGUI_SSE_HEADERS },
        ),
    });
    const seen: string[] = [];
    await agent.runAgent({ runId: 'r' }, { onEvent: ({ event }) => void seen.push(event.type) });
    assert.deepEqual(seen, ['RUN_STARTED', 'CUSTOM', 'RUN_FINISHED']);
  });

  it("client disconnect clears Mastra's queued follow-ups for the thread", async () => {
    for (const how of ['abort-signal', 'stream-cancel'] as const) {
      for (const mastraQueued of [0, 1]) {
        const calls: string[] = [];
        let listener: ((e: any) => void) | undefined;
        let queueListener: ((e: { type: string; count?: number }) => void) | undefined;
        let runId: string | null = 'mastra-run';
        const agent: AguiThreadQueue = {
          subscribeThreadEvents(scope, l) {
            calls.push(`subscribe:${scope.resourceId}/${scope.threadId}`);
            queueListener = l;
            return () => {
              calls.push('unsubscribe');
              queueListener = undefined;
            };
          },
          abortThreadStream(o) {
            calls.push(`abortThreadStream:${o.resourceId}/${o.threadId}:${o.clearPendingSignals}:${o.localOnly}`);
            return true;
          },
        };
        const session: AguiSession = {
          subscribe(l) {
            listener = l;
            return () => {
              listener = undefined;
            };
          },
          abort() {
            calls.push('abort');
            runId = null;
          },
          getCurrentRunId: () => runId,
          cleanupFollowUpBinding: () => void calls.push('cleanupFollowUpBinding'),
          machinery: { getAgent: () => agent },
        };
        let closed = 0;
        const ac = new AbortController();
        const stream = aguiRunStream({
          session,
          threadId: 't',
          runId: 'r',
          mastraThreadId: 'mt',
          resourceId: 'res',
          signal: ac.signal,
          heartbeatMs: 0,
          onClose: () => void closed++,
          start: () => new Promise(() => {}),
        });
        const reader = stream.getReader();
        await reader.read();
        listener?.({ type: 'agent_start' });
        if (mastraQueued) queueListener?.({ type: 'queue-count-changed', count: mastraQueued });
        if (how === 'abort-signal') ac.abort();
        else await reader.cancel();
        const label = `${how}, mastra queue ${mastraQueued}`;
        assert.deepEqual(
          calls,
          [
            'subscribe:res/mt',
            'cleanupFollowUpBinding',
            'abort',
            ...(mastraQueued ? ['abortThreadStream:res/mt:true:true'] : []),
            'unsubscribe',
          ],
          label,
        );
        assert.equal(closed, 1, label);
      }
    }
  });

  it("client disconnect: a follow-up queued in Mastra's session never runs", async () => {
    const stub = await createStubAgentController({
      script: (call) =>
        call === 1 ? stubText('t1', Array.from({ length: 30 }, (_, i) => `w${i} `)) : stubText('t2', ['late']),
      chunkDelayMs: 20,
    });
    const session = await stub.createSession(RESOURCE, 'agui');
    let queued = false;
    await runTurn(session, {
      send: () => session.sendMessage({ content: 'long answer' }),
      onEvent: (event, agent) => {
        if (event.type === 'TEXT_MESSAGE_CONTENT' && !queued) {
          queued = true;
          void session.followUp({ content: 'queued in mastra' });
          setTimeout(() => agent.abortRun(), 40);
        }
      },
    });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(stub.modelCalls, 1, 'the Mastra follow-up must not run after the client has gone');
  });

  it('queued turns that will not run are reported before RUN_FINISHED', async () => {
    const stub = await createStubAgentController({
      script: () => stubText('t1', Array.from({ length: 30 }, (_, i) => `w${i} `)),
      chunkDelayMs: 20,
    });
    const session = await stub.createSession(RESOURCE, 'agui');
    const threadId = session.thread.getId() ?? 'thread';
    let dropped = 0;
    let aborted = false;
    const agent = new HttpAgent({
      url: 'http://agui.test/run',
      threadId,
      initialMessages: [{ id: 'u1', role: 'user', content: 'hi' }],
      fetch: async () =>
        new Response(
          aguiRunStream({
            session: session as unknown as AguiSession,
            threadId,
            runId: 'run-1',
            mastraThreadId: threadId,
            start: () => session.sendMessage({ content: 'long answer' }),
            droppedQueuedTurns: () => dropped,
          }),
          { headers: AGUI_SSE_HEADERS },
        ),
    });
    const events: Ev[] = [];
    let failure: unknown;
    await agent
      .runAgent(
        { runId: 'run-1' },
        {
          onEvent: ({ event }) => {
            events.push(event as Ev);
            if (event.type === 'TEXT_MESSAGE_CONTENT' && !aborted) {
              aborted = true;
              dropped = 2;
              session.abort();
            }
          },
          onRunFailed: ({ error }) => {
            failure = error;
          },
        },
      )
      .catch((err: unknown) => {
        failure = failure ?? err;
      });
    assert.equal(failure, undefined);
    const last = events.at(-1)!;
    assert.equal(last.type, 'RUN_FINISHED');
    assert.deepEqual(last.outcome, { type: 'cancelled' });
    const prev = events.at(-2)!;
    assert.equal(prev.type, 'CUSTOM');
    assert.equal(prev.name, 'tourbillon.follow_up_dropped');
    assert.deepEqual(prev.value, { count: 2 });
  });
});

