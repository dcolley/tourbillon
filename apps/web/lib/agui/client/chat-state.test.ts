/** AGUI-1b: pure reducer for the AG-UI run stream (chat-state.ts). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRunEvent,
  endRun,
  initialAgentChatState,
  markDroppedFollowUps,
  mergeHistory,
  mergeHistoryPage,
  RUN_CANCELLED_MESSAGE,
  seedHistory,
  settleAfterResume,
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

describe('STREAM-1 mergeHistory / settleAfterResume / START on a shown item', () => {
  const u = (id: string, text: string, delivery: UserMessageDelivery = 'delivered'): AgentChatItem => ({
    kind: 'user',
    id,
    text,
    mode: 'run',
    delivery,
  });
  const a = (id: string, text: string, streaming = false): AgentChatItem => ({ kind: 'assistant', id, text, streaming });

  it('history first (stored copies win), then local-only items; own sends replaced by their stored copy', () => {
    const local = withItems([u('old-u', 'earlier'), a('old-a', 'earlier reply'), u('client-1', 'hi'), a('m', 'hal', true), u('client-2', 'failed one', 'failed')]);
    const merged = mergeHistory(local, [u('old-u', 'earlier'), a('old-a', 'earlier reply'), u('s-1', 'hi'), a('m', 'half done'), u('s-9', 'other tab'), a('m9', 'more')]);
    assert.deepEqual(
      merged.items.map((i) => `${i.kind}:${i.id}:${(i as { text: string }).text}`),
      [
        'user:old-u:earlier',
        'assistant:old-a:earlier reply',
        'user:s-1:hi',
        'assistant:m:half done',
        'user:s-9:other tab',
        'assistant:m9:more',
        'user:client-2:failed one',
      ],
    );
  });

  it('an unsent local message with the same text as an older stored one is kept', () => {
    const local = withItems([u('old', 'yes'), u('client-1', 'yes', 'queued')]);
    const merged = mergeHistory(local, [u('old', 'yes')]);
    assert.deepEqual(merged.items.map((i) => i.id), ['old', 'client-1']);
  });

  it('empty history leaves the state alone; a waiting tool call keeps its local state', () => {
    const local = withItems([{ kind: 'tool', id: 'c1', name: 'ask', argsText: '{}', status: 'awaiting_approval' } as AgentChatItem]);
    assert.equal(mergeHistory(local, []), local);
    const merged = mergeHistory(local, [{ kind: 'tool', id: 'c1', name: 'ask', argsText: '{}', status: 'running' } as AgentChatItem]);
    assert.equal((merged.items[0] as { status: string }).status, 'awaiting_approval');
  });

  it('settleAfterResume: idle, streaming closed, queued follow-ups dropped, disconnected error cleared', () => {
    const st = settleAfterResume(
      withItems([u('q', 'later', 'queued'), a('m', 'x', true)], { error: { kind: 'disconnected', message: 'lost' } }),
    );
    assert.equal(st.status, 'idle');
    assert.equal(st.error, null);
    assert.deepEqual(deliveries(st), ['dropped']);
    assert.equal((st.items[1] as { streaming: boolean }).streaming, false);
    const idle = withItems([a('m', 'x')], { status: 'idle' });
    assert.equal(settleAfterResume(idle), idle);
    const other = settleAfterResume(withItems([], { status: 'idle', error: { kind: 'http', message: 'boom', status: 500 } }));
    assert.equal(other.error?.kind, 'http');
  });

  it('a START for a shown message / tool call restarts it in place (re-attached replay)', () => {
    let s = withItems([u('u', 'hi'), a('m', 'half', true), { kind: 'tool', id: 't', name: 'x', argsText: '{"a"', status: 'streaming_args' } as AgentChatItem]);
    s = apply(
      s,
      { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'half and more' },
      { type: 'TOOL_CALL_START', toolCallId: 't', toolCallName: 'x' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 't', delta: '{"a":1}' },
    );
    assert.deepEqual(s.items.map((i) => i.id), ['u', 'm', 't']);
    assert.equal((s.items[1] as { text: string }).text, 'half and more');
    assert.equal((s.items[2] as { argsText: string }).argsText, '{"a":1}');
  });
});

describe('STREAM-1 × CHAT-PAGE-1 mergeHistoryPage (resume reloads only the newest page)', () => {
  const u = (id: string, text: string, delivery: UserMessageDelivery = 'delivered'): AgentChatItem => ({
    kind: 'user',
    id,
    text,
    mode: 'run',
    delivery,
  });
  const a = (id: string, text: string, streaming = false): AgentChatItem => ({ kind: 'assistant', id, text, streaming });
  const ids = (s: AgentChatState) => s.items.map((i) => i.id);
  const pager = { hasMore: true, cursor: 'p1' };

  it('older pages already shown (Load previous) stay in front of the newest page, pager unchanged', () => {
    const local = withItems([u('o1', 'old'), a('o2', 'old reply'), u('p1', 'q'), a('p2', 'half', true)], {
      history: { hasMore: true, cursor: 'o1', loading: false },
    });
    const merged = mergeHistoryPage(local, [u('p1', 'q'), a('p2', 'done'), u('p3', 'other tab')], pager);
    assert.deepEqual(ids(merged), ['o1', 'o2', 'p1', 'p2', 'p3']);
    assert.equal((merged.items[3] as { text: string }).text, 'done');
    assert.deepEqual(merged.history, { hasMore: true, cursor: 'o1', loading: false });
  });

  it('own send before the page anchor is replaced by its stored copy (no duplicate)', () => {
    const local = withItems([u('o1', 'old'), u('client-1', 'hi'), a('m', 'ha', true)], {
      history: { hasMore: false, cursor: 'o1', loading: false },
    });
    const merged = mergeHistoryPage(local, [u('s-1', 'hi'), a('m', 'hallo')], { hasMore: true, cursor: 's-1' });
    assert.deepEqual(ids(merged), ['o1', 's-1', 'm']);
  });

  it('more than a page written meanwhile: restarts at the page, keeps own undelivered sends, pager moves', () => {
    const local = withItems([u('o1', 'old'), a('o2', 'old reply'), u('client-2', 'failed one', 'failed')], {
      history: { hasMore: false, cursor: 'o1', loading: false },
    });
    const merged = mergeHistoryPage(local, [u('n1', 'new'), a('n2', 'new reply')], { hasMore: true, cursor: 'n1' });
    assert.deepEqual(ids(merged), ['n1', 'n2', 'client-2']);
    assert.deepEqual(merged.history, { hasMore: true, cursor: 'n1', loading: false });
  });

  // B1: shown messages that came from the store (older pages, or ones that fell out of the newest
  // page) are never text-matched as this client's own sends.
  const pagedIn = (newest: AgentChatItem[], older: AgentChatItem[], own: AgentChatItem[] = []) => {
    let s: AgentChatState = { ...withItems([]), history: { hasMore: true, cursor: newest[0]!.id, loading: false } };
    s = seedHistory(s, newest);
    s = { ...seedHistory(s, older), history: { hasMore: false, cursor: older[0]!.id, loading: false } };
    return { ...s, items: [...s.items, ...own] };
  };

  it('B1: older paged-in message with the same text as an own in-flight send is kept, no duplicate', () => {
    const local = pagedIn([u('p1', 'q'), a('p2', 'r')], [u('o1', 'continue'), a('o2', 'ok')], [u('client-1', 'continue', 'sending')]);
    const merged = mergeHistoryPage(local, [u('p1', 'q'), a('p2', 'r'), u('s-1', 'continue'), a('s-2', 'going')], pager);
    assert.deepEqual(ids(merged), ['o1', 'o2', 'p1', 'p2', 's-1', 's-2']);
  });

  it('B1: another tab sending an older message text does not remove the older one', () => {
    const local = pagedIn([u('p1', 'q'), a('p2', 'r')], [u('o1', 'SEED-07'), a('o2', 'ok')]);
    const merged = mergeHistoryPage(local, [u('p1', 'q'), a('p2', 'r'), u('s-1', 'SEED-07')], pager);
    assert.deepEqual(ids(merged), ['o1', 'o2', 'p1', 'p2', 's-1']);
  });

  it('B1: a message that fell out of the newest page keeps its place when its text is sent again', () => {
    let local = seedHistory(
      { ...withItems([]), history: { hasMore: false, cursor: 'x1', loading: false } },
      [u('x1', 'again'), a('x2', 'one'), u('x3', 'q'), a('x4', 'two')],
    );
    local = { ...local, items: [...local.items, u('client-1', 'again', 'delivered')] };
    const merged = mergeHistoryPage(local, [u('x3', 'q'), a('x4', 'two'), u('s-1', 'again'), a('s-2', 'three')], { hasMore: true, cursor: 'x3' });
    assert.deepEqual(ids(merged), ['x1', 'x2', 'x3', 'x4', 's-1', 's-2']);
    // A second resume with the same page changes nothing.
    assert.deepEqual(ids(mergeHistoryPage(merged, [u('x3', 'q'), a('x4', 'two'), u('s-1', 'again'), a('s-2', 'three')], { hasMore: true, cursor: 'x3' })), ids(merged));
  });

  it('no page shown yet: plain mergeHistory and the pager takes the page cursor; empty page is a no-op', () => {
    const local = withItems([u('client-1', 'hi')]);
    const merged = mergeHistoryPage(local, [u('s-1', 'hi'), a('m', 'reply')], pager);
    assert.deepEqual(ids(merged), ['s-1', 'm']);
    assert.deepEqual(merged.history, { hasMore: true, cursor: 'p1', loading: false });
    assert.equal(mergeHistoryPage(local, [], pager), local);
  });
});
