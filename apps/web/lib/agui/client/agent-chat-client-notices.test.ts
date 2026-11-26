/**
 * TB-363 — the open chat page must see task notices WITHOUT a prompt or reload (contract
 * A1 open-page, A3 busy-chat deferral, A4.3 client dedup, A10-R2 push gap).
 *
 * Root cause R2 at base bdd1d970: a bridge-delivered notice is persisted as a signal row by a
 * server-side wake run; the client only ever learned of runs it started or re-attached to, and
 * no browser code consumed the company SSE bus — so an open page showed nothing until a reload
 * or the next user turn. The fix: the client merges the STORED transcript (keyed upsert by
 * message id — never a client-invented item) when idle (refresh timer) and on bridge pokes
 * (`handleTaskNotice`), deferring pokes that arrive mid-turn until the run settles.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentChatClient } from './agent-chat-client';
import type { AgentChatItem, AgentChatState } from './chat-state';
import { createFakeAguiServer, controlResponse, tick, until, type FakeRequest } from './testing/fake-agui-server';

const THREAD = 'thread-1';
const RESOURCE = 'company-co-1:chat:free';

let ids = 0;
const newId = () => `tb363-id-${++ids}`;

// TB-363 (MUST-2): VERBATIM real Mastra 1.81 accepted-signal row (PG probe): role 'signal',
// a plain TEXT part carrying the human line, content.metadata.signal with the attributes,
// top-level type 'task-progress'. (NOT the synthetic data-signal shape used in early drafts —
// on base the real shape rendered as a fake user bubble; the fix must suppress that.)
const signalRow = (id: string, stage: string, contents?: string) => ({
  id,
  role: 'signal',
  content: {
    format: 2,
    parts: [
      {
        type: 'text',
        text: contents ?? `Background task done: "Ship the runbook".`,
      },
    ],
    metadata: {
      signal: {
        id,
        type: 'reactive',
        tagName: 'task-progress',
        attributes: { taskId: 'task-1', runId: 'run-1', stage, status: stage === 'failed' ? 'failed' : 'succeeded' },
      },
    },
  },
  type: 'task-progress',
});

const userMsg = (id: string, text: string) => ({ id, role: 'user', content: { parts: [{ type: 'text', text }] } });
const assistantMsg = (id: string, text: string) => ({ id, role: 'assistant', content: { parts: [{ type: 'text', text }] } });

interface Resumable {
  server: ReturnType<typeof createFakeAguiServer>;
  client: AgentChatClient;
  stored: unknown[];
}

function resumable(
  handler: (req: FakeRequest) => Response | 'stream' | Promise<Response | 'stream'>,
  extra: Partial<ConstructorParameters<typeof AgentChatClient>[0]> = {},
): Resumable {
  const stored: unknown[] = [];
  const server = createFakeAguiServer(handler);
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(String(url), 'http://local');
    if (u.pathname.endsWith('/messages')) {
      const limit = Number(u.searchParams.get('limit') ?? String(stored.length));
      const page = stored.slice(Math.max(0, stored.length - limit));
      return new Response(JSON.stringify({ messages: page, hasMore: stored.length > page.length }), {
        headers: { 'Content-Type': 'application/json' },
      });
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
    // Deterministic: no background poll unless the case under test is the poll itself.
    noticePollMs: 0,
    noticeRefresh: { attempts: 3, delaysMs: [0, 0, 0] },
    ...extra,
  });
  return { server, client, stored };
}

const runAndControls = (controls: Record<string, (req: FakeRequest) => Response | 'stream'> = {}) =>
  (req: FakeRequest): Response | 'stream' =>
    req.action === 'run' ? 'stream' : (controls[req.action]?.(req) ?? controlResponse(req.body, { accepted: true }));

const notices = (s: AgentChatState) => s.items.filter((i): i is Extract<AgentChatItem, { kind: 'notice' }> => i.kind === 'notice');
const started = (req: FakeRequest) => ({ type: 'RUN_STARTED', threadId: req.body.threadId, runId: req.body.runId });
const finished = (req: FakeRequest, type = 'success') => ({ type: 'RUN_FINISHED', threadId: req.body.threadId, runId: req.body.runId, outcome: { type } });

describe('TB-363 open-page notice delivery (agent-chat-client)', () => {
  it('A1: an idle open page shows the bridge-persisted done notice with no user prompt and no reload', async () => {
    const { client, stored } = resumable(runAndControls(), { noticePollMs: 20 });
    assert.equal(notices(client.getState()).length, 0);
    // The bridge (server side) persists the notice row; nothing is sent by the user.
    stored.push(userMsg('u0', 'earlier'), assistantMsg('a0', 'sure.'));
    await tick(60); // idle poll has merged the baseline
    stored.push(signalRow('sig-idle-1', 'done'));
    await until(() => notices(client.getState()).length === 1, 2000, 'open page shows the notice unprompted');
    const n = notices(client.getState())[0]!;
    assert.equal(n.stage, 'done');
    assert.match(n.text, /Ship the runbook/);
    client.dispose();
  });

  it('A10: root cause R2 — a stored signal row reaches the open page without the client having started or attached a run', async () => {
    const { client, stored } = resumable(runAndControls());
    stored.push(signalRow('sig-r2', 'waiting_on_user', 'Background task "T" is waiting on the human: pick a date. reply here'));
    client.handleTaskNotice({ threadId: THREAD });
    await until(() => notices(client.getState()).length === 1, 2000, 'poke merges the stored notice');
    assert.equal(notices(client.getState())[0]!.stage, 'waiting_on_user');
    client.dispose();
  });

  it('A3: a notice arriving mid-turn is NOT injected mid-stream and lands exactly once after the run settles', async () => {
    const { server, client, stored } = resumable(runAndControls({ attach: (req) => controlResponse(req.body, { accepted: false, running: false }) }));
    void client.send('first');
    await until(() => server.streams.length === 1);
    const stream = server.streams[0];
    stream.send(started(server.requests[0]), { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'half' });
    await until(() => client.getState().items.some((i) => i.kind === 'assistant'));
    // The server persists the turn's rows as it goes; the bridge delivers the notice into the
    // session queue mid-turn — the row becomes visible only once the run settles (Mastra queue
    // semantics), which is exactly what the client must never race with.
    stored.push(userMsg('u-turn', 'first'), assistantMsg('m', 'half'));
    stored.push(signalRow('sig-busy', 'done'));
    client.handleTaskNotice({ threadId: THREAD });
    await tick(30);
    assert.equal(notices(client.getState()).length, 0, 'never mid-stream (M2): held until the turn settles');
    assert.ok(client.getState().items.some((i) => i.kind === 'assistant' && !(i as { text?: string }).text?.includes('Background task')), 'the running turn output is untouched');
    stream.send(finished(server.requests[0]));
    stream.close();
    await until(() => notices(client.getState()).length === 1, 2000, 'one notice after settle');
    const items = client.getState().items;
    const noticeIdx = items.findIndex((i) => i.kind === 'notice');
    const assistantIdx = items.map((i) => i.kind).lastIndexOf('assistant');
    assert.ok(noticeIdx > assistantIdx, 'the notice sits AFTER the settled turn output');
    client.dispose();
  });

  it('A3d: the deferred notice is still delivered exactly once when the running turn ERRORS', async () => {
    const { server, client, stored } = resumable(runAndControls({ attach: (req) => controlResponse(req.body, { accepted: false, running: false }) }));
    void client.send('first');
    await until(() => server.streams.length === 1);
    stored.push(signalRow('sig-err', 'failed', 'Background task "T" FAILED: worker died.'));
    client.handleTaskNotice({ threadId: THREAD });
    server.streams[0].send(started(server.requests[0]), { type: 'RUN_ERROR', message: 'model exploded' });
    server.streams[0].close();
    await until(() => notices(client.getState()).length === 1, 2000, 'not lost on error (M4)');
    client.dispose();
  });

  it('A3d: the deferred notice is still delivered exactly once when the user ABORTS the turn', async () => {
    const { server, client, stored } = resumable(runAndControls({ abort: (req) => controlResponse(req.body, { accepted: true }) }));
    void client.send('first');
    await until(() => server.streams.length === 1);
    stored.push(signalRow('sig-abort', 'done'));
    client.handleTaskNotice({ threadId: THREAD });
    void client.abort();
    // A real accepted abort ends the endpoint run, so the stream terminates; the fake must too.
    await until(() => client.getState().status === 'stopping', 1000, 'abort accepted');
    server.streams[0].send(finished(server.requests[0]));
    server.streams[0].close();
    await until(() => notices(client.getState()).length === 1, 2000, 'not lost on abort (M4)');
    client.dispose();
  });

  it('A4.3: pokes, repeated pokes and a history reload collapse to ONE item per stored signal id', async () => {
    const { client, stored } = resumable(runAndControls());
    stored.push(signalRow('sig-once', 'done'));
    client.handleTaskNotice({ threadId: THREAD });
    client.handleTaskNotice({ threadId: THREAD });
    client.handleTaskNotice({});
    await until(() => notices(client.getState()).length === 1, 2000, 'dedup to one');
    await client.loadHistory('merge');
    await client.loadHistory('merge');
    assert.equal(notices(client.getState()).length, 1, 'keyed upsert by stored message id, never append (M8)');
    client.dispose();
  });

  it('A7: a poke for another thread does not touch this chat', async () => {
    const { client, stored } = resumable(runAndControls());
    stored.push(signalRow('sig-other', 'done'));
    client.handleTaskNotice({ threadId: 'someone-elses-thread' });
    await tick(40);
    assert.equal(notices(client.getState()).length, 0);
    client.dispose();
  });

  it('S-3: a hidden tab does not idle-poll; becoming visible refreshes at once and dispose unsubscribes', async () => {
    const listeners: Array<() => void> = [];
    let removed = 0;
    const fakeDoc = {
      hidden: true,
      addEventListener: (_ev: string, h: () => void) => { listeners.push(h); },
      removeEventListener: (_ev: string, _h: () => void) => { removed++; },
    };
    (globalThis as Record<string, unknown>).document = fakeDoc;
    try {
      const { client, stored } = resumable(runAndControls(), { noticePollMs: 15 });
      stored.push(userMsg('u0', 'earlier'), assistantMsg('a0', 'sure.'), signalRow('sig-hidden-1', 'done'));
      await tick(80); // several poll windows elapse while hidden
      assert.equal(notices(client.getState()).length, 0, 'hidden tabs must not poll notices in');
      assert.equal(listeners.length, 1, 'visibilitychange subscribed once');
      fakeDoc.hidden = false;
      listeners[0]!(); // the tab becomes visible: refresh runs immediately, not after an interval
      await until(() => notices(client.getState()).length === 1, 2000, 'visible refresh shows the notice');
      client.dispose();
      assert.equal(removed, 1, 'dispose removes the visibilitychange listener');
    } finally {
      delete (globalThis as Record<string, unknown>).document;
    }
  });
});
