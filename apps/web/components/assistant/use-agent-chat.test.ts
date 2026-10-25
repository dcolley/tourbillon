/**
 * P0 (agent switch): switching agents in the Assistant remounts the chat (assistant-route-view.tsx keys
 * AgentChat on agent + thread); each mount (connectAgentChat, the body of useAgentChat's effect) must
 * open a new client that fetches the thread's messages fresh, so returning to an agent shows what it
 * wrote while the user was on another agent.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connectAgentChat } from './use-agent-chat';
import { AgentChatClient } from '@/lib/agui/client/agent-chat-client';
import type { AgentChatItem } from '@/lib/agui/client/chat-state';
import { controlResponse, createFakeAguiServer, tick, until } from '@/lib/agui/client/testing/fake-agui-server';

type Stored = { id: string; role: string; content: unknown; createdAt?: string };
const text = (id: string, role: 'user' | 'assistant', t: string): Stored => ({ id, role, content: { format: 2, parts: [{ type: 'text', text: t }] } });

const THREADS: Record<string, string> = { alice: 'thread-a', bob: 'thread-b' };

/** Server double: persisted messages per thread (mutable, as the agent writes), the history GET and the AG-UI POSTs. */
function world(pendingWidgets: Record<string, unknown[]> = {}) {
  const stored: Record<string, Stored[]> = { 'thread-a': [], 'thread-b': [] };
  const historyCalls: Array<{ url: string; cache?: RequestCache }> = [];
  const agui = createFakeAguiServer((req) => controlResponse(req.body, { accepted: true, widgets: pendingWidgets[req.body.threadId] ?? [] }));
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const m = /^\/api\/assistant\/agents\/([^/]+)\/threads\/([^/]+)\/messages(?:\?(.*))?$/.exec(String(url));
    if (m && (init.method ?? 'GET') === 'GET') {
      historyCalls.push({ url: String(url), cache: init.cache });
      const thread = decodeURIComponent(m[2]);
      // A copy: what the server has at the time of the request (CHAT-PAGE-1: paged by limit / before).
      const all = [...(stored[thread] ?? [])];
      const q = new URLSearchParams(m[3] ?? '');
      if (!q.has('limit') && !q.has('before')) return new Response(JSON.stringify({ messages: all, hasMore: false }), { status: 200 });
      const limit = Number(q.get('limit') ?? 20);
      const before = q.get('before');
      const end = before ? all.findIndex((s) => s.id === before) : all.length;
      const start = Math.max(0, end - limit);
      return new Response(JSON.stringify({ messages: all.slice(start, end), hasMore: start > 0 }), { status: 200 });
    }
    return agui.fetch(url as never, init as never);
  }) as unknown as typeof fetch;
  return { stored, historyCalls, agui, fetchImpl };
}

/** Mounts the chat for an agent like the route does; resolves once it is ready. */
async function mount(w: ReturnType<typeof world>, agentId: string) {
  let ready: AgentChatClient | null = null;
  let error: string | null = null;
  const cleanup = connectAgentChat({
    key: `${agentId}\u0000`,
    agentId,
    openThread: async (_k, agent) => ({ threadId: THREADS[agent], created: false }),
    createClient: (o) => new AgentChatClient({ ...o, fetch: w.fetchImpl, retry: { attempts: 0, delayMs: 1 } }),
    onReady: (client) => {
      ready = client;
    },
    onError: (e) => {
      error = e;
    },
  });
  await until(() => ready !== null || error !== null, 2000, `chat for ${agentId}`);
  assert.equal(error, null);
  return { client: ready! as AgentChatClient, cleanup };
}

const texts = (items: AgentChatItem[]) => items.map((i) => (i.kind === 'user' || i.kind === 'assistant' ? `${i.kind}:${i.text}` : `${i.kind}:${i.id}`));

describe('Assistant agent switch shows freshly fetched messages', () => {
  it('A → B → A: the second mount of A fetches again and shows what A wrote meanwhile', async () => {
    const w = world();
    w.stored['thread-a'].push(text('u1', 'user', 'hi alice'), text('a1', 'assistant', 'hello'));
    w.stored['thread-b'].push(text('u2', 'user', 'hi bob'), text('b1', 'assistant', 'yo'));

    const a1 = await mount(w, 'alice');
    assert.deepEqual(texts(a1.client.getState().items), ['user:hi alice', 'assistant:hello']);
    a1.cleanup();

    const b = await mount(w, 'bob');
    assert.deepEqual(texts(b.client.getState().items), ['user:hi bob', 'assistant:yo']);
    // Alice writes while the user is on Bob (e.g. a run finishing, a heartbeat reply).
    w.stored['thread-a'].push(text('a2', 'assistant', 'done: report ready'));
    b.cleanup();

    const a2 = await mount(w, 'alice');
    assert.notEqual(a2.client, a1.client, 'a new client per mount (no disposed client reused)');
    assert.deepEqual(texts(a2.client.getState().items), ['user:hi alice', 'assistant:hello', 'assistant:done: report ready']);
    assert.deepEqual(
      w.historyCalls.map((c) => [c.url, c.cache]),
      [
        ['/api/assistant/agents/alice/threads/thread-a/messages?limit=20', 'no-store'],
        ['/api/assistant/agents/bob/threads/thread-b/messages?limit=20', 'no-store'],
        ['/api/assistant/agents/alice/threads/thread-a/messages?limit=20', 'no-store'],
      ],
    );
    a2.cleanup();
  });

  it('the chat is ready only once the history is shown (no empty transcript first)', async () => {
    const w = world();
    w.stored['thread-a'].push(text('u1', 'user', 'earlier'));
    const { client, cleanup } = await mount(w, 'alice');
    assert.equal(client.getState().items.length, 1);
    cleanup();
  });

  it('a card still waiting is restored on its stored call after the history (one item, suspended)', async () => {
    const args = { question: 'Pick', options: ['a', 'b'] };
    const w = world({ 'thread-a': [{ toolCallId: 'c1', toolName: 'askChoice', args }] });
    w.stored['thread-a'].push(text('u1', 'user', 'ask me'), {
      id: 'a1',
      role: 'assistant',
      content: { format: 2, parts: [{ type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: 'c1', toolName: 'askChoice', args } }] },
    });
    const { client, cleanup } = await mount(w, 'alice');
    await until(() => client.getState().pendingTools.length === 1, 2000, 'pending card restored');
    const tools = client.getState().items.filter((i) => i.kind === 'tool');
    assert.equal(tools.length, 1);
    assert.equal((tools[0] as { status: string }).status, 'suspended');
    cleanup();
  });

  it('leaving before the history arrives disposes the client and never reports ready', async () => {
    const w = world();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let created: AgentChatClient | null = null;
    let readyCalls = 0;
    const cleanup = connectAgentChat({
      key: 'alice\u0000',
      agentId: 'alice',
      openThread: async () => ({ threadId: 'thread-a', created: false }),
      createClient: (o) => {
        created = new AgentChatClient({
          ...o,
          fetch: (async (url: string, init: RequestInit) => {
            await gate;
            return w.fetchImpl(url as never, init as never);
          }) as unknown as typeof fetch,
        });
        return created;
      },
      onReady: () => {
        readyCalls += 1;
      },
      onError: () => {},
    });
    await until(() => created !== null, 2000, 'client created');
    cleanup();
    release();
    await tick(20);
    assert.equal(readyCalls, 0);
    assert.equal((await created!.send('x')).ok, false, 'disposed');
  });

  it('a history that cannot be loaded is shown as the chat error; the chat still opens', async () => {
    const w = world();
    const failing = (async (url: string, init: RequestInit) =>
      /\/messages(\?|$)/.test(String(url))
        ? new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
        : w.fetchImpl(url as never, init as never)) as unknown as typeof fetch;
    let ready: AgentChatClient | null = null;
    const cleanup = connectAgentChat({
      key: 'alice\u0000',
      agentId: 'alice',
      openThread: async () => ({ threadId: 'thread-a', created: false }),
      createClient: (o) => new AgentChatClient({ ...o, fetch: failing }),
      onReady: (c) => {
        ready = c;
      },
      onError: () => {},
    });
    await until(() => ready !== null, 2000, 'ready');
    const error = (ready as unknown as AgentChatClient).getState().error;
    assert.equal(error?.kind, 'http');
    assert.match(error?.message ?? '', /Could not load earlier messages: boom/);
    cleanup();
  });

  describe('CHAT-PAGE-1: transcript pager', () => {
    const fill = (w: ReturnType<typeof world>, n: number) => {
      for (let i = 1; i <= n; i++) w.stored['thread-a'].push(text(`m${i}`, i % 2 ? 'user' : 'assistant', `msg ${i}`));
    };
    const shown = (c: AgentChatClient) => c.getState().items.map((i) => (i.kind === 'user' || i.kind === 'assistant' ? i.text : i.id));

    it('opens on the newest 20 messages only, with Load previous available', async () => {
      const w = world();
      fill(w, 45);
      const { client, cleanup } = await mount(w, 'alice');
      assert.equal(w.historyCalls[0].url, '/api/assistant/agents/alice/threads/thread-a/messages?limit=20');
      const items = shown(client);
      assert.equal(items.length, 20);
      assert.equal(items[0], 'msg 26');
      assert.equal(items[19], 'msg 45');
      assert.deepEqual(client.getState().history, { hasMore: true, cursor: 'm26', loading: false });
      cleanup();
    });

    it('Load previous prepends the 20 before the oldest shown (cursor = oldest stored id), until none are left', async () => {
      const w = world();
      fill(w, 45);
      const { client, cleanup } = await mount(w, 'alice');
      const loading = client.loadPrevious();
      assert.equal(client.getState().history.loading, true, 'loading while the page is in flight');
      assert.equal((await loading).ok, true);
      assert.equal(w.historyCalls[1].url, '/api/assistant/agents/alice/threads/thread-a/messages?limit=20&before=m26');
      let items = shown(client);
      assert.equal(items.length, 40);
      assert.deepEqual([items[0], items[19], items[20], items[39]], ['msg 6', 'msg 25', 'msg 26', 'msg 45']);
      assert.deepEqual(client.getState().history, { hasMore: true, cursor: 'm6', loading: false });

      await client.loadPrevious();
      items = shown(client);
      assert.equal(items.length, 45);
      assert.equal(items[0], 'msg 1');
      assert.deepEqual(client.getState().history, { hasMore: false, cursor: 'm1', loading: false });

      // Nothing older: no request.
      const calls = w.historyCalls.length;
      assert.equal((await client.loadPrevious()).ok, true);
      assert.equal(w.historyCalls.length, calls);
      cleanup();
    });

    it('a short thread opens whole, with no Load previous', async () => {
      const w = world();
      fill(w, 3);
      const { client, cleanup } = await mount(w, 'alice');
      assert.equal(shown(client).length, 3);
      assert.equal(client.getState().history.hasMore, false);
      cleanup();
    });

    it('concurrent Load previous clicks send one request; a failed page keeps the cursor and shows the error', async () => {
      const w = world();
      fill(w, 30);
      const { client, cleanup } = await mount(w, 'alice');
      const first = client.loadPrevious();
      const second = client.loadPrevious();
      await Promise.all([first, second]);
      assert.equal(w.historyCalls.length, 2, 'open + one page');
      assert.equal(shown(client).length, 30);

      const w2 = world();
      fill(w2, 30);
      let fail = false;
      const flaky = (async (url: string, init: RequestInit) =>
        fail && /before=/.test(String(url))
          ? new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
          : w2.fetchImpl(url as never, init as never)) as unknown as typeof fetch;
      let ready: AgentChatClient | null = null;
      const stop = connectAgentChat({
        key: 'alice\u0000flaky',
        agentId: 'alice',
        openThread: async () => ({ threadId: 'thread-a', created: false }),
        createClient: (o) => new AgentChatClient({ ...o, fetch: flaky }),
        onReady: (c) => {
          ready = c;
        },
        onError: () => {},
      });
      await until(() => ready !== null, 2000, 'ready');
      const c = ready as unknown as AgentChatClient;
      fail = true;
      const r = await c.loadPrevious();
      assert.equal(r.ok, false);
      assert.match(c.getState().error?.message ?? '', /Could not load earlier messages: boom/);
      assert.deepEqual(c.getState().history, { hasMore: true, cursor: 'm11', loading: false });
      assert.equal(shown(c).length, 20, 'transcript unchanged');
      fail = false;
      await c.loadPrevious();
      assert.equal(shown(c).length, 30, 'retry works');
      stop();
      cleanup();
    });

    it('B1: resume after Load previous keeps an older message whose text was sent again (no drop, no duplicate)', async () => {
      const w = world();
      fill(w, 25);
      const { client, cleanup } = await mount(w, 'alice');
      await client.loadPrevious();
      assert.equal(shown(client).length, 25);
      // Another tab (or this one, persisted while the stream was lost) sends the text of an older message.
      w.stored['thread-a'].push(text('m26', 'user', 'msg 3'), text('m27', 'assistant', 'again'));
      assert.equal((await client.resume()).ok, true);
      const items = shown(client);
      assert.equal(items.length, 27);
      assert.deepEqual([items[0], items[2], items[24], items[25], items[26]], ['msg 1', 'msg 3', 'msg 25', 'msg 3', 'again']);
      cleanup();
    });

    it('messages written after open do not shift the previous page (cursor, not offset)', async () => {
      const w = world();
      fill(w, 25);
      const { client, cleanup } = await mount(w, 'alice');
      // Written after the chat opened (not shown here): the before-cursor page is unaffected.
      w.stored['thread-a'].push(text('m26', 'user', 'msg 26'));
      await client.loadPrevious();
      const items = shown(client);
      assert.equal(items[0], 'msg 1');
      assert.equal(items[items.length - 1], 'msg 25');
      assert.equal(items.length, 25);
      cleanup();
    });
  });
});
