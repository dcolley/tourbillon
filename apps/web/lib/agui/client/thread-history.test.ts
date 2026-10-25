/**
 * P0 (agent switch): persisted thread messages → assistant chat items, and the history fetch
 * (never cached). Stored shapes are Mastra v2 memory messages.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chatItemsFromStoredMessages, fetchThreadHistory, type StoredThreadMessage } from './thread-history';

const msg = (id: string, role: string, parts: unknown[] | string, createdAt?: string): StoredThreadMessage => ({
  id,
  role,
  content: typeof parts === 'string' ? parts : { format: 2, parts },
  ...(createdAt ? { createdAt } : {}),
});

describe('chatItemsFromStoredMessages', () => {
  it('user and assistant turns in order; the dashboard context block is not shown', () => {
    const items = chatItemsFromStoredMessages([
      msg('u1', 'user', [{ type: 'text', text: '[Dashboard context]\ntype: issue\n[/Dashboard context]\n\nfix this' }]),
      msg('a1', 'assistant', [{ type: 'step-start' }, { type: 'text', text: 'On ' }, { type: 'text', text: 'it.' }]),
    ]);
    assert.deepEqual(items, [
      { kind: 'user', id: 'u1', text: 'fix this', mode: 'run', delivery: 'delivered' },
      { kind: 'assistant', id: 'a1', text: 'On it.', streaming: false },
    ]);
  });

  it('segment ids match the live stream (session-events segmentId), so feedback maps to the message id', () => {
    const items = chatItemsFromStoredMessages([
      msg('a1', 'assistant', [
        { type: 'reasoning', reasoning: '', details: [{ type: 'text', text: 'think' }] },
        { type: 'text', text: 'Looking.' },
        { type: 'tool-invocation', toolInvocation: { state: 'result', toolCallId: 'c1', toolName: 'search', args: { q: 'x' }, result: { hits: 2 } } },
        { type: 'text', text: 'Found 2.' },
      ]),
      msg('a2', 'assistant', [{ type: 'text', text: 'Plain first.' }]),
    ]);
    assert.deepEqual(
      items.map((i) => [i.kind, i.id]),
      [
        ['reasoning', 'a1:reasoning:0'],
        ['assistant', 'a1:text:1'],
        ['tool', 'c1'],
        ['assistant', 'a1:text:2'],
        ['assistant', 'a2'],
      ],
    );
    const tool = items[2] as Extract<(typeof items)[number], { kind: 'tool' }>;
    assert.deepEqual(tool, {
      kind: 'tool',
      id: 'c1',
      name: 'search',
      argsText: '{"q":"x"}',
      status: 'done',
      result: '{"hits":2}',
      parentMessageId: 'a1',
    });
  });

  it('a tool call without a stored result is running; a later result for the same call wins', () => {
    const call = { type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: 'c1', toolName: 'askChoice', args: { q: 1 } } };
    const result = { type: 'tool-invocation', toolInvocation: { state: 'result', toolCallId: 'c1', toolName: 'askChoice', args: { q: 1 }, result: 'ok' } };
    assert.equal((chatItemsFromStoredMessages([msg('a1', 'assistant', [call])])[0] as { status: string }).status, 'running');
    const both = chatItemsFromStoredMessages([msg('a1', 'assistant', [call]), msg('a2', 'assistant', [result])]);
    assert.equal(both.length, 1);
    assert.equal((both[0] as { status: string; result?: string }).status, 'done');
    assert.equal((both[0] as { result?: string }).result, 'ok');
  });

  it('signal (follow-up) user turns, plain string content; system / tool / empty messages skipped', () => {
    const items = chatItemsFromStoredMessages([
      msg('s0', 'system', [{ type: 'text', text: 'sys' }]),
      msg('u1', 'signal', [{ type: 'data-user-message', data: { contents: 'and also' } }]),
      msg('a1', 'assistant', 'string reply'),
      msg('t1', 'tool', [{ type: 'text', text: 'tool row' }]),
      msg('u2', 'user', [{ type: 'text', text: '   ' }]),
      msg('a2', 'assistant', [{ type: 'step-start' }]),
    ]);
    assert.deepEqual(items, [
      { kind: 'user', id: 'u1', text: 'and also', mode: 'run', delivery: 'delivered' },
      { kind: 'assistant', id: 'a1', text: 'string reply', streaming: false },
    ]);
  });
});

describe('fetchThreadHistory', () => {
  it('GETs the thread messages for the agent, never from the HTTP cache', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ messages: [msg('u1', 'user', [{ type: 'text', text: 'hi' }])] }), { status: 200 });
    }) as unknown as typeof fetch;
    const messages = await fetchThreadHistory({ agentId: 'al ice', threadId: 't/1', fetch: f });
    assert.equal(messages.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/assistant/agents/al%20ice/threads/t%2F1/messages');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.cache, 'no-store');
  });

  it('a failed response throws with its status and message; unusable ids fail without a request', async () => {
    let n = 0;
    const f = (async () => {
      n += 1;
      return new Response(JSON.stringify({ error: 'Thread not found' }), { status: 404 });
    }) as unknown as typeof fetch;
    await assert.rejects(fetchThreadHistory({ agentId: 'alice', threadId: 't1', fetch: f }), { message: 'Thread not found', status: 404 });
    await assert.rejects(fetchThreadHistory({ agentId: 'alice', threadId: '..', fetch: f }), { status: 404 });
    assert.equal(n, 1);
  });
});
