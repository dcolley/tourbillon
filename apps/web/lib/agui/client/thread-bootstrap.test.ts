/** AGUI-1b: thread bootstrap through the chat REST API (the AG-UI endpoint never creates threads). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ASSISTANT_REST_SCOPE, AguiThreadBootstrapError, openAguiThread } from './thread-bootstrap';

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
  it('opens the session, then creates a new chat thread for the agent', async () => {
    const { f, calls } = fakeFetch([
      json({ resourceId: 'company-c1:chat:free', agentName: 'Alice' }),
      json({ id: 'thread-9', title: 'New chat' }, 201),
    ]);
    const ref = await openAguiThread({ agentId: 'alice', fetch: f });
    assert.deepEqual(ref, { resourceId: 'company-c1:chat:free', threadId: 'thread-9', agentName: 'Alice' });
    assert.equal(calls[0].url, '/api/chat/alice/sessions');
    assert.deepEqual(calls[0].body, { tags: { kind: 'chat', contextType: 'free' }, sessionScope: ASSISTANT_REST_SCOPE });
    assert.equal(calls[1].url, `/api/chat/alice/sessions/${encodeURIComponent('company-c1:chat:free')}/threads?sessionScope=assistant`);
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].body.title, 'New chat');
  });

  it('an existing thread id skips thread creation', async () => {
    const { f, calls } = fakeFetch([json({ resourceId: 'r' })]);
    assert.deepEqual(await openAguiThread({ agentId: 'a b', threadId: 't1', fetch: f }), { resourceId: 'r', threadId: 't1', agentName: undefined });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/chat/a%20b/sessions');
  });

  it('errors carry the endpoint message and status', async () => {
    const { f } = fakeFetch([json({ error: 'Agent not found' }, 404)]);
    await assert.rejects(openAguiThread({ agentId: 'x', fetch: f }), (e: unknown) => {
      assert.ok(e instanceof AguiThreadBootstrapError);
      assert.equal(e.message, 'Agent not found');
      assert.equal(e.status, 404);
      return true;
    });
    const { f: f2 } = fakeFetch([json({ resourceId: 'r' }), new Response('oops', { status: 500 })]);
    await assert.rejects(openAguiThread({ agentId: 'x', fetch: f2 }), /Could not start a new chat/);
    const { f: f3 } = fakeFetch([json({})]);
    await assert.rejects(openAguiThread({ agentId: 'x', fetch: f3 }), /Could not open the chat/);
  });
});
