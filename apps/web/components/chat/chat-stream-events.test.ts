import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chatMessagePlainText,
  isChatUserMessage,
  mergeChatMessage,
  reduceChatStreamMessages,
  type ChatMessage,
} from './use-agent-chat-session';
import {
  applyMessageUpdate,
  chatStreamEffectsFor,
  chatStreamRunningFor,
  isForeignThreadMessage,
  MAX_PART_INDEX,
  type ChatStreamEvent,
} from './chat-stream-events';

/**
 * Event sequence a real Mastra 1.75 session emits for one user turn answered "Hello world"
 * (captured from AgentController with a mocked streaming model). `message_update` carries
 * only a delta and `message_end` only an id; the full text is never on those events.
 */
const USER_ID = '933e44e0-b7f8-41b6-94a5-77be19732802';
const ASSISTANT_ID = 'f710c787-c42b-40d5-a998-cce0faa361d3';
const userSignal = {
  id: USER_ID,
  role: 'signal',
  content: {
    format: 2,
    parts: [{ type: 'data-user-message', data: { id: USER_ID, type: 'user', contents: 'hi' } }],
  },
  createdAt: '2026-10-16T18:02:29.299Z',
};
const assistant = (text: string) => ({
  id: ASSISTANT_ID,
  role: 'assistant',
  content: { format: 2, parts: [{ type: 'text', text }] },
  createdAt: '2026-10-16T18:02:29.334Z',
});
const ds = (isRunning: boolean, currentMessage: unknown) => ({
  type: 'display_state_changed',
  displayState: { isRunning, currentMessage, queuedFollowUps: 0, activeTools: {} },
});

const MASTRA_1_75_TURN: ChatStreamEvent[] = [
  { type: 'agent_start' },
  ds(true, null),
  { type: 'message_start', message: userSignal },
  ds(true, userSignal),
  { type: 'message_end', id: USER_ID },
  { type: 'message_start', message: assistant('') },
  ds(true, assistant('')),
  { type: 'message_update', id: ASSISTANT_ID, event: { type: 'text-delta', delta: 'Hello ' } },
  ds(true, assistant('Hello ')),
  { type: 'message_update', id: ASSISTANT_ID, event: { type: 'text-delta', delta: 'world' } },
  ds(true, assistant('Hello world')),
  { type: 'message_end', id: ASSISTANT_ID },
  { type: 'agent_end', reason: 'complete' },
  ds(false, assistant('Hello world')),
];

/** Same path as the hook: SSE frame → JSON → message reducer + running flag. */
function playOverWire(start: ChatMessage[], events: ChatStreamEvent[]) {
  let messages = start;
  let running = false;
  for (const raw of events) {
    const event = JSON.parse(JSON.stringify(raw)) as ChatStreamEvent;
    messages = reduceChatStreamMessages(messages, event);
    const next = chatStreamRunningFor(event);
    if (next !== undefined) running = next;
  }
  return { messages, running };
}

function sendOptimistic(text: string): ChatMessage[] {
  return mergeChatMessage([], {
    id: 'local-1',
    role: 'user',
    content: { format: 2, parts: [{ type: 'text', text }] },
    createdAt: '2026-10-16T18:02:29.200Z',
  });
}

function assistantTexts(messages: ChatMessage[]): string[] {
  return messages.filter((m) => m.role === 'assistant').map(chatMessagePlainText);
}

describe('agent chat stream renders the reply in the open session', () => {
  it('send → streamed reply shows in place and the working state clears (no reload)', () => {
    const { messages, running } = playOverWire(sendOptimistic('hi'), MASTRA_1_75_TURN);
    assert.deepEqual(assistantTexts(messages), ['Hello world']);
    assert.equal(running, false, 'working state must clear on agent_end');
    const users = messages.filter(isChatUserMessage);
    assert.equal(users.length, 1, 'optimistic bubble replaced by the real user turn');
    assert.equal(users[0]?.id, USER_ID);
  });

  it('applies text deltas even without display-state snapshots', () => {
    const deltasOnly = MASTRA_1_75_TURN.filter((e) => e.type !== 'display_state_changed');
    const { messages, running } = playOverWire(sendOptimistic('hi'), deltasOnly);
    assert.deepEqual(assistantTexts(messages), ['Hello world']);
    assert.equal(running, false);
  });

  it('shows partial text mid-stream', () => {
    const { messages, running } = playOverWire(sendOptimistic('hi'), MASTRA_1_75_TURN.slice(0, 8));
    assert.deepEqual(assistantTexts(messages), ['Hello ']);
    assert.equal(running, true);
  });

  it('replaces a part by index and still merges legacy full-message updates', () => {
    let messages = reduceChatStreamMessages([], { type: 'message_start', message: assistant('a') });
    messages = reduceChatStreamMessages(messages, {
      type: 'message_update',
      id: ASSISTANT_ID,
      event: { type: 'part', index: 0, part: { type: 'text', text: 'replaced' } },
    });
    assert.deepEqual(assistantTexts(messages), ['replaced']);
    messages = reduceChatStreamMessages(messages, { type: 'message_update', message: assistant('legacy') });
    assert.deepEqual(assistantTexts(messages), ['legacy']);
  });

  it('ignores updates for unknown ids and stale snapshots after the run ends', () => {
    const start = reduceChatStreamMessages([], { type: 'message_start', message: assistant('done') });
    const a = reduceChatStreamMessages(start, {
      type: 'message_update',
      id: 'other',
      event: { type: 'text-delta', delta: 'x' },
    });
    assert.equal(a, start);
    const b = reduceChatStreamMessages(start, ds(false, { ...assistant('stale'), id: 'old' }));
    assert.equal(b, start);
  });
});

describe('stream thread guard, hook effects and input bounds', () => {
  const OPEN = 'thread-open';
  const OTHER = 'thread-other';
  const m = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    id,
    role: 'assistant',
    content: { format: 2, parts: [{ type: 'text', text }] },
    createdAt: '2026-10-16T18:00:00.000Z',
    ...extra,
  });
  const snap = (isRunning: boolean, currentMessage: unknown): ChatStreamEvent => ({
    type: 'display_state_changed',
    displayState: { isRunning, currentMessage },
  });

  it('B1: live snapshot from another thread does not render in the open thread', () => {
    const prev = [m('a', 'mine', { threadId: OPEN })];
    const next = reduceChatStreamMessages(prev, snap(true, m('x', 'foreign', { threadId: OTHER })), OPEN);
    assert.equal(next, prev);
  });

  it('B1: full-message events from another thread are skipped', () => {
    const prev: ChatMessage[] = [];
    for (const type of ['message_start', 'message_update', 'message_end']) {
      const next = reduceChatStreamMessages(prev, { type, message: m('x', 'foreign', { threadId: OTHER }) }, OPEN);
      assert.equal(next, prev, type);
    }
  });

  it('B1: same-thread and untagged messages still render', () => {
    const a = reduceChatStreamMessages([], snap(true, m('x', 'same', { threadId: OPEN })), OPEN);
    assert.equal(chatMessagePlainText(a[0]!), 'same');
    const b = reduceChatStreamMessages([], { type: 'message_start', message: m('y', 'untagged') }, OPEN);
    assert.equal(b.length, 1);
    assert.equal(isForeignThreadMessage(m('z', '', { threadId: OTHER }), null), false);
  });

  it('hook: agent_end reloads the open thread; nothing else does', () => {
    assert.deepEqual(chatStreamEffectsFor({ type: 'agent_end' }, OPEN), { running: false, reloadThreadId: OPEN });
    assert.equal(chatStreamEffectsFor({ type: 'agent_end' }, null).reloadThreadId, null);
    assert.equal(chatStreamEffectsFor({ type: 'agent_start' }, OPEN).reloadThreadId, null);
    assert.equal(chatStreamEffectsFor(snap(false, null), OPEN).reloadThreadId, null);
  });

  it('hook: running state from agent_start, agent_end and display snapshots', () => {
    assert.equal(chatStreamEffectsFor({ type: 'agent_start' }, OPEN).running, true);
    assert.equal(chatStreamEffectsFor({ type: 'agent_end' }, OPEN).running, false);
    assert.equal(chatStreamEffectsFor(snap(true, null), OPEN).running, true);
    assert.equal(chatStreamEffectsFor(snap(false, null), OPEN).running, false);
    assert.equal(chatStreamEffectsFor({ type: 'message_update', id: 'a' }, OPEN).running, undefined);
  });

  it('delta after a non-text part opens a new text part; consecutive deltas extend it', () => {
    let msg: ChatMessage = { id: 'a', role: 'assistant', content: { parts: [{ type: 'tool-call' }] } };
    msg = applyMessageUpdate(msg, { type: 'text-delta', delta: 'He' });
    msg = applyMessageUpdate(msg, { type: 'text-delta', delta: 'llo' });
    assert.deepEqual(msg.content.parts, [{ type: 'tool-call' }, { type: 'text', text: 'Hello' }]);
  });

  it('rejects negative, huge, gapped indexes and non-string deltas', () => {
    const msg = m('a', 'x');
    const part = { type: 'text', text: 'BAD' };
    assert.equal(applyMessageUpdate(msg, { type: 'part', index: -1, part }), msg);
    assert.equal(applyMessageUpdate(msg, { type: 'part', index: MAX_PART_INDEX + 1, part }), msg);
    assert.equal(applyMessageUpdate(msg, { type: 'part', index: 5, part }), msg);
    assert.equal(applyMessageUpdate(msg, { type: 'text-delta', delta: 42 }), msg);
    const appended = applyMessageUpdate(msg, { type: 'part', index: 1, part });
    assert.equal(appended.content.parts?.length, 2);
  });

  it('ignores user-role snapshots', () => {
    const prev: ChatMessage[] = [];
    assert.equal(reduceChatStreamMessages(prev, snap(true, { ...m('u', 'hi'), role: 'user' })), prev);
  });
});

describe('stream thread guard without an explicit open thread', () => {
  it('uses the thread of the messages already shown', () => {
    const prev: ChatMessage[] = [{ id: 'b', role: 'assistant', content: { parts: [{ type: 'text', text: 'B' }] }, threadId: 'tB' }];
    const ev: ChatStreamEvent = { type: 'message_start', message: { id: 'a', role: 'assistant', content: { parts: [] }, threadId: 'tA' } };
    assert.equal(reduceChatStreamMessages(prev, ev), prev);
  });
});
