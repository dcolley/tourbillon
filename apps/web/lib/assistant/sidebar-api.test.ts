/** UI-2b: browser client for the UI-2 assistant API (URLs, bodies, error mapping, chat hand-off URL). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AssistantApiError, assistantChatHref, createAssistantSidebarApi } from './sidebar-api';

function fake(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = responses.shift();
    if (!r) throw new Error('unexpected request');
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { api: createAssistantSidebarApi(f), calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const thread = { id: 't1', agentId: 'a1', title: 'T', pinned: false, unread: false, lastActivityAt: null, createdAt: null };

describe('UI-2b assistant sidebar API client', () => {
  it('chat links are /assistant/<agent-url-key>[/<threadId>] (segments encoded)', () => {
    assert.equal(assistantChatHref('alice', 't-1'), '/assistant/alice/t-1');
    assert.equal(assistantChatHref('alice'), '/assistant/alice');
    assert.equal(assistantChatHref('a b', 'x/y?z'), '/assistant/a%20b/x%2Fy%3Fz');
  });

  it('list agents / threads, create, update: URLs, methods and bodies match the UI-2 routes', async () => {
    const { api, calls } = fake([
      json({ companyId: 'c1', agents: [] }),
      json({ agentId: 'a1', threads: [thread], initialThreadId: 't1' }),
      json({ agentId: 'a1', threads: [], initialThreadId: null }),
      json({ thread }, 201),
      json({ thread: { ...thread, title: 'New' } }),
    ]);
    assert.deepEqual(await api.listAgents(), { companyId: 'c1', agents: [] });
    assert.equal((await api.listThreads('alice')).initialThreadId, 't1');
    await api.listThreads('al ice', { q: 'plan b', limit: 5 });
    assert.deepEqual(await api.createThread('alice'), thread);
    assert.equal((await api.updateThread('alice', 't/1', { title: 'New' })).title, 'New');
    assert.deepEqual(calls, [
      { url: '/api/assistant/agents', method: 'GET', body: undefined },
      { url: '/api/assistant/agents/alice/threads', method: 'GET', body: undefined },
      { url: '/api/assistant/agents/al%20ice/threads?q=plan+b&limit=5', method: 'GET', body: undefined },
      { url: '/api/assistant/agents/alice/threads', method: 'POST', body: {} },
      { url: '/api/assistant/agents/alice/threads/t%2F1', method: 'PATCH', body: { title: 'New' } },
    ]);
  });

  it('errors carry the API message, status and Retry-After', async () => {
    const { api } = fake([
      json({ error: 'Pin limit reached (50 threads per agent)' }, 409),
      json({ error: 'Too many new threads for this company; try again in 12s' }, 429, { 'Retry-After': '12' }),
      new Response('<html>', { status: 502 }),
      new TypeError('Failed to fetch'),
    ]);
    await assert.rejects(api.updateThread('a', 't', { pinned: true }), (e: unknown) => {
      assert.ok(e instanceof AssistantApiError);
      assert.deepEqual([e.status, e.message], [409, 'Pin limit reached (50 threads per agent)']);
      return true;
    });
    await assert.rejects(api.createThread('a'), (e: AssistantApiError) => e.status === 429 && e.retryAfterSec === 12);
    await assert.rejects(api.listAgents(), (e: AssistantApiError) => e.status === 502 && e.message === 'Request failed (502)');
    await assert.rejects(api.listAgents(), (e: AssistantApiError) => e.status === 0 && /Network error/.test(e.message));
  });
});
