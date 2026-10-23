/** AGUI-1b: thread bootstrap through the assistant thread API (the AG-UI endpoint never creates threads). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AguiThreadBootstrapError, isUsableAguiId, openAguiThread } from './thread-bootstrap';

function fakeFetch(responses: Array<Response | (() => Response)>) {
  const calls: Array<{ url: string; body: any; method?: string }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined, method: init.method });
    const r = responses.shift();
    if (!r) throw new Error('unexpected request');
    return typeof r === 'function' ? r() : r;
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('AGUI-1b openAguiThread', () => {
  it('reuses the agent’s initial thread: no thread is created', async () => {
    const { f, calls } = fakeFetch([json({ agentId: 'agent-a', threads: [{ id: 'thread-3' }], initialThreadId: 'thread-3' })]);
    assert.deepEqual(await openAguiThread({ agentId: 'alice', fetch: f }), { threadId: 'thread-3', created: false });
    assert.deepEqual(calls.map((c) => [c.method, c.url]), [['GET', '/api/assistant/agents/alice/threads']]);
  });

  it('creates a thread only when the agent has none', async () => {
    const { f, calls } = fakeFetch([
      json({ agentId: 'agent-a', threads: [], initialThreadId: null }),
      json({ thread: { id: 'thread-9', title: '' } }, 201),
    ]);
    assert.deepEqual(await openAguiThread({ agentId: 'alice', fetch: f }), { threadId: 'thread-9', created: true });
    assert.deepEqual(calls.map((c) => [c.method, c.url]), [
      ['GET', '/api/assistant/agents/alice/threads'],
      ['POST', '/api/assistant/agents/alice/threads'],
    ]);
    assert.deepEqual(calls[1].body, {});
  });

  it('a given thread id is checked against the agent before the chat opens', async () => {
    const { f, calls } = fakeFetch([json({ thread: { id: 't 1' } })]);
    assert.deepEqual(await openAguiThread({ agentId: 'a b', threadId: 't 1', fetch: f }), { threadId: 't 1', created: false });
    assert.deepEqual(calls.map((c) => [c.method, c.url]), [['GET', '/api/assistant/agents/a%20b/threads/t%201']]);
  });

  it('an unknown or foreign thread id fails on open with the endpoint message', async () => {
    const { f } = fakeFetch([json({ error: 'Thread not found' }, 404)]);
    await assert.rejects(openAguiThread({ agentId: 'alice', threadId: 'foreign', fetch: f }), (e: unknown) => {
      assert.ok(e instanceof AguiThreadBootstrapError);
      assert.equal(e.message, 'Thread not found');
      assert.equal(e.status, 404);
      return true;
    });
    // A 200 for a different thread is not accepted either.
    const { f: f2 } = fakeFetch([json({ thread: { id: 'other' } })]);
    await assert.rejects(openAguiThread({ agentId: 'alice', threadId: 'mine', fetch: f2 }), /Could not open this chat/);
  });

  it('dot-only agent or thread ids are refused without a request', async () => {
    const { f, calls } = fakeFetch([]);
    for (const agentId of ['.', '..', '...', '']) {
      await assert.rejects(openAguiThread({ agentId, fetch: f }), /Agent not found/, agentId);
    }
    for (const threadId of ['.', '..', '']) {
      await assert.rejects(openAguiThread({ agentId: 'alice', threadId, fetch: f }), /Thread not found/, threadId);
    }
    assert.equal(calls.length, 0);
    assert.equal(isUsableAguiId('a.b'), true);
    assert.equal(isUsableAguiId('.a'), true);
    assert.equal(isUsableAguiId('..'), false);
  });

  it('errors carry the endpoint message and status', async () => {
    const { f } = fakeFetch([json({ error: 'Agent not found' }, 404)]);
    await assert.rejects(openAguiThread({ agentId: 'x', fetch: f }), (e: unknown) => {
      assert.ok(e instanceof AguiThreadBootstrapError);
      assert.equal(e.message, 'Agent not found');
      assert.equal(e.status, 404);
      return true;
    });
    const { f: f2 } = fakeFetch([json({ initialThreadId: null }), new Response('oops', { status: 500 })]);
    await assert.rejects(openAguiThread({ agentId: 'x', fetch: f2 }), /Could not start a new chat/);
    const { f: f3 } = fakeFetch([json({ initialThreadId: null }), json({ thread: {} }, 201)]);
    await assert.rejects(openAguiThread({ agentId: 'x', fetch: f3 }), /Could not start a new chat/);
    const { f: f4 } = fakeFetch([json({ error: 'Agent is archived; its threads are read-only' }, 409)]);
    await assert.rejects(openAguiThread({ agentId: 'x', fetch: f4 }), /archived/);
  });
});
