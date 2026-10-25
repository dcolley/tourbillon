/** AGUI-1b: pure reducer for the AG-UI run stream (chat-state.ts). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRunEvent,
  endRun,
  initialAgentChatState,
  markDroppedFollowUps,
  RUN_CANCELLED_MESSAGE,
  type AgentChatItem,
  type AgentChatState,
  type UserMessageDelivery,
} from './chat-state';

const user = (id: string, mode: 'run' | 'followUp' | 'steer', delivery: UserMessageDelivery): AgentChatItem => ({
  kind: 'user',
  id,
  text: id,
  mode,
  delivery,
});
const withItems = (items: AgentChatItem[], extra: Partial<AgentChatState> = {}): AgentChatState => ({
  ...initialAgentChatState,
  status: 'running',
  items,
  ...extra,
});
const apply = (s: AgentChatState, ...events: Array<Record<string, unknown> & { type: string }>) =>
  events.reduce(applyRunEvent, s);
const deliveries = (s: AgentChatState) => s.items.filter((i) => i.kind === 'user').map((i) => (i as { delivery: string }).delivery);

describe('AGUI-1b chat state', () => {
  it('RUN_STARTED marks the sending run message delivered and clears a previous error', () => {
    const s = apply(withItems([user('u', 'run', 'sending')], { status: 'starting', error: { kind: 'network', message: 'x' } }), {
      type: 'RUN_STARTED',
      runId: 'r1',
    });
    assert.equal(s.status, 'running');
    assert.equal(s.runId, 'r1');
    assert.equal(s.error, null);
    assert.deepEqual(deliveries(s), ['delivered']);
  });

  it('RUN_STARTED keeps a pending stop', () => {
    assert.equal(apply(withItems([], { status: 'stopping' }), { type: 'RUN_STARTED' }).status, 'stopping');
  });

  it('text and reasoning accumulate per message id; content without a start still shows', () => {
    const s = apply(
      withItems([]),
      { type: 'REASONING_MESSAGE_START', messageId: 'r' },
      { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r', delta: 'think' },
      { type: 'REASONING_MESSAGE_END', messageId: 'r' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: 'Hi' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: ' you' },
    );
    assert.deepEqual(s.items, [
      { kind: 'reasoning', id: 'r', text: 'think', streaming: false },
      { kind: 'assistant', id: 'a', text: 'Hi you', streaming: true },
    ]);
  });

  it('tool calls: args stream, end → running, result → done / error / denied, pending decision cleared', () => {
    let s = apply(
      withItems([]),
      { type: 'TOOL_CALL_START', toolCallId: 't', toolCallName: 'echo', parentMessageId: 'm' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 't', delta: '{"a":' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 't', delta: '1}' },
    );
    assert.deepEqual(s.items[0], { kind: 'tool', id: 't', name: 'echo', argsText: '{"a":1}', status: 'streaming_args', parentMessageId: 'm' });
    s = apply(s, { type: 'TOOL_CALL_END', toolCallId: 't' });
    assert.equal((s.items[0] as { status: string }).status, 'running');
    s = apply(s, { type: 'CUSTOM', name: 'tourbillon.tool_approval_required', value: { toolCallId: 't', toolName: 'echo', args: { a: 1 } } });
    assert.equal((s.items[0] as { status: string }).status, 'awaiting_approval');
    assert.equal(s.pendingTools.length, 1);
    s = apply(s, { type: 'TOOL_CALL_RESULT', toolCallId: 't', content: 'boom', metadata: { isError: true } });
    assert.equal((s.items[0] as { status: string }).status, 'error');
    assert.equal((s.items[0] as { result: string }).result, 'boom');
    assert.deepEqual(s.pendingTools, []);
  });

  it('markDroppedFollowUps works from a running total, newest queued first', () => {
    let s = withItems([user('a', 'followUp', 'queued'), user('b', 'followUp', 'queued'), user('c', 'followUp', 'queued')]);
    s = markDroppedFollowUps(s, 1);
    assert.deepEqual(deliveries(s), ['queued', 'queued', 'dropped']);
    assert.equal(markDroppedFollowUps(s, 1), s, 'same total again is a no-op');
    s = markDroppedFollowUps(s, 2);
    assert.deepEqual(deliveries(s), ['queued', 'dropped', 'dropped']);
  });

  it('endRun: success delivers queued follow-ups; cancelled / error / disconnected drop them; sending is left alone', () => {
    const items = [user('q', 'followUp', 'queued'), user('s', 'followUp', 'sending'), { kind: 'assistant', id: 'm', text: 'x', streaming: true } as AgentChatItem];
    assert.deepEqual(deliveries(endRun(withItems(items), 'success')), ['delivered', 'sending']);
    for (const outcome of ['cancelled', 'error', 'disconnected'] as const) {
      const s = endRun(withItems(items), outcome);
      assert.deepEqual(deliveries(s), ['dropped', 'sending'], outcome);
      assert.equal(s.status, 'idle');
      assert.equal((s.items[2] as { streaming: boolean }).streaming, false);
    }
  });

  it('endRun keeps pending tools only on interrupt', () => {
    const pending = [{ toolCallId: 't', toolName: 'x', reason: 'tool_approval' as const, args: null }];
    assert.equal(endRun(withItems([], { pendingTools: pending }), 'interrupt').pendingTools.length, 1);
    assert.equal(endRun(withItems([], { pendingTools: pending }), 'success').pendingTools.length, 0);
  });

  it('RUN_FINISHED maps the outcome; RUN_ERROR sets a run error', () => {
    assert.equal(apply(withItems([]), { type: 'RUN_FINISHED', outcome: { type: 'cancelled' } }).lastOutcome, 'cancelled');
    assert.equal(apply(withItems([]), { type: 'RUN_FINISHED' }).lastOutcome, 'success');
    const e = apply(withItems([]), { type: 'RUN_ERROR', message: 'bad' });
    assert.deepEqual([e.lastOutcome, e.error], ['error', { kind: 'run', message: 'bad' }]);
  });

  it('endRun on interrupt delivers queued follow-ups (they ran inside the run)', () => {
    const s = endRun(withItems([user('q', 'followUp', 'queued')]), 'interrupt');
    assert.deepEqual(deliveries(s), ['delivered']);
  });

  it('a cancelled run the user stopped clears a stale error; one the user did not stop says so', () => {
    const stale = { kind: 'conflict' as const, message: 'stale' };
    const stopped = endRun(withItems([], { status: 'stopping', error: stale }), 'cancelled');
    assert.equal(stopped.error, null);
    for (const status of ['running', 'starting'] as const) {
      const notAsked = endRun(withItems([], { status, error: stale }), 'cancelled');
      assert.deepEqual(notAsked.error, { kind: 'cancelled', message: RUN_CANCELLED_MESSAGE }, status);
    }
    const viaEvent = apply(withItems([]), { type: 'RUN_FINISHED', outcome: { type: 'cancelled' } });
    assert.equal(viaEvent.error?.kind, 'cancelled');
    const stoppedViaEvent = apply(withItems([], { status: 'stopping' }), { type: 'RUN_FINISHED', outcome: { type: 'cancelled' } });
    assert.equal(stoppedViaEvent.error, null);
    // Success and interrupt still clear a stale error.
    assert.equal(endRun(withItems([], { error: stale }), 'success').error, null);
    assert.equal(endRun(withItems([], { error: stale }), 'interrupt').error, null);
  });

  it('unknown events leave the state unchanged', () => {
    const s = withItems([]);
    assert.equal(apply(s, { type: 'STATE_SNAPSHOT' }, { type: 'CUSTOM', name: 'other' }), s);
  });
});

describe('seedHistory (P0: transcript loaded when the chat opens)', () => {
  it('puts the stored items before what the client holds; items it already has are kept as they are', async () => {
    const { seedHistory, initialAgentChatState: init } = await import('./chat-state');
    const live = { kind: 'assistant' as const, id: 'a2', text: 'live', streaming: true };
    const state = { ...init, status: 'running' as const, items: [live] };
    const next = seedHistory(state, [
      { kind: 'user', id: 'u1', text: 'hi', mode: 'run', delivery: 'delivered' },
      { kind: 'assistant', id: 'a2', text: 'stored', streaming: false },
    ]);
    assert.deepEqual(next.items.map((i) => i.id), ['u1', 'a2']);
    assert.equal((next.items[1] as { text: string }).text, 'live');
    assert.equal(next.status, 'running');
    assert.equal(seedHistory(state, []), state);
  });
});
