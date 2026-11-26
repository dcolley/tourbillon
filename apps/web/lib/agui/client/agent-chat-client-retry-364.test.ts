/**
 * TB-364 SEED (Test Lead). Failing-first acceptance cells for the Assistant Chat failed-message
 * retry queue, at the AgentChatClient seam. Grounded on main 8b243bc2 (fake-agui-server +
 * AgentChatClient). Hermes owns turning these green; keep the case ids (A1, A4, A5, A6, A8, A11, A12/A13, A14/A35) in the
 * test names. These are SEEDS: the full cell list is tb364-CONTRACT.md (A1..A38).
 *
 * Normative wire names (contract §2, rename only with PM + Test ack):
 *   forwardedProps.tourbillon.clientMessageId  — stable idempotency key, one per user message
 *   forwardedProps.tourbillon.modelOverride    — { providerId, modelId } for "Retry on another model"
 * Client API names used here (contract §2): client.retry(itemId, { model?: { providerId, modelId } }).
 *
 * Red on base (main 8b243bc2): every cell below fails (see RESULT table). No product code touched.
 * Must be added to HARNESS_TEST_FILES in apps/web/scripts/run-harness-tests.mjs (CI does NOT run
 * the plain `apps/web test` glob) and pinned in packages/scheduler/src/ci-coverage-s316-s4-s328-s4.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentChatClient } from './agent-chat-client';
import { initialAgentChatState, mergeHistory, type AgentChatItem, type AgentChatState } from './chat-state';
import { chatItemsFromStoredMessages } from './thread-history';
import { createFakeAguiServer, controlResponse, jsonError, tick, until, type FakeRequest } from './testing/fake-agui-server';

const THREAD = 'thread-364';
const RESOURCE = 'company-co-1:chat:free';
// Verbatim shape of the failure Derek saw on TEST (issue #364): provider/LiteLLM text in RUN_ERROR.
const RAW_LITELLM =
  "litellm.InternalServerError: OpenAIException - Connection error. LiteLLM: model group 'spark1/inkling-2-mini' failed ... no fallback model group was found for it";

let ids = 0;
const newId = () => `tb364-id-${++ids}`;

type RetryApi = {
  retry(itemId: string, opts?: { model?: { providerId: string; modelId: string } }): Promise<unknown>;
  discard(itemId: string): Promise<unknown> | unknown;
};
const retryOf = (c: AgentChatClient) => (c as unknown as RetryApi).retry.bind(c);
const discardOf = (c: AgentChatClient) => (c as unknown as RetryApi).discard.bind(c);

const users = (s: AgentChatState) => s.items.filter((i): i is Extract<AgentChatItem, { kind: 'user' }> => i.kind === 'user');
const started = (req: FakeRequest) => ({ type: 'RUN_STARTED', threadId: req.body.threadId, runId: req.body.runId });
const runError = (message = RAW_LITELLM) => ({ type: 'RUN_ERROR', message, code: 'agent_error' });
const keyOf = (req: FakeRequest): unknown => req.body.forwardedProps?.tourbillon?.clientMessageId;

function make(handler: (req: FakeRequest) => Response | 'stream' | Promise<Response | 'stream'>, extra: Record<string, unknown> = {}) {
  const server = createFakeAguiServer(handler);
  const client = new AgentChatClient({
    agentId: 'alice',
    threadId: THREAD,
    resourceId: RESOURCE,
    fetch: server.fetch,
    newId,
    retry: { attempts: 0, delayMs: 1 },
    ...extra,
  } as ConstructorParameters<typeof AgentChatClient>[0]);
  return { server, client };
}

describe('TB-364 seed: failed-message retry queue (AgentChatClient)', () => {
  it('A1: a run that errors after RUN_STARTED keeps the user message in the thread marked FAILED (once), not delivered', async () => {
    const { server, client } = make((req) => (req.action === 'run' ? 'stream' : controlResponse(req.body, { accepted: true })));
    void client.send('what needs my attention the most?');
    await until(() => server.streams.length === 1, 2000, 'run stream open');
    server.streams[0]!.send(started(server.requests[0]!), runError());
    server.streams[0]!.close();
    await until(() => client.getState().status === 'idle', 2000, 'run ended');
    const u = users(client.getState());
    assert.equal(u.length, 1, 'the failed message stays, exactly once');
    assert.equal(u[0]!.text, 'what needs my attention the most?');
    assert.equal(u[0]!.delivery, 'failed', 'marked failed so Retry can be offered (base: delivered → RED)');
  });

  it('A11: a follow-up queued behind a run that then ERRORS is not dropped (issue: "a failed run does not drop later messages")', async () => {
    const { server, client } = make((req) => (req.action === 'run' ? 'stream' : controlResponse(req.body, { accepted: true, queued: 1 })));
    void client.send('first');
    await until(() => server.streams.length === 1, 2000, 'run stream open');
    server.streams[0]!.send(started(server.requests[0]!));
    await until(() => client.getState().status === 'running', 2000, 'running');
    await client.send('second, while the first is running');
    await until(() => users(client.getState()).some((i) => i.text.startsWith('second') && i.delivery === 'queued'), 2000, 'second queued');
    server.streams[0]!.send(runError());
    server.streams[0]!.close();
    await until(() => client.getState().status === 'idle', 2000, 'run ended');
    const second = users(client.getState()).find((i) => i.text.startsWith('second'))!;
    assert.notEqual(second.delivery, 'dropped', 'base marks it dropped ("Not sent — the run ended first") → RED');
    const first = users(client.getState()).find((i) => i.text === 'first')!;
    assert.equal(first.delivery, 'failed');
  });

  it('A5: every send carries a stable clientMessageId; Retry re-sends the SAME key and text and adds NO second user message', async () => {
    let attempt = 0;
    const { server, client } = make((req) => {
      if (req.action !== 'run') return controlResponse(req.body, { accepted: true });
      attempt++;
      return attempt === 1 ? jsonError(502, 'Bad gateway') : 'stream';
    });
    await client.send('hello');
    assert.equal(users(client.getState()).length, 1);
    const failedItem = users(client.getState())[0]!;
    assert.equal(failedItem.delivery, 'failed');
    const first = server.requests[0]!;
    assert.equal(typeof keyOf(first), 'string', 'first send has an idempotency key (base: absent → RED)');
    assert.ok(String(keyOf(first)).length >= 8);
    void retryOf(client)(failedItem.id);
    await until(() => server.requests.length === 2, 2000, 'retry request sent');
    const second = server.requests[1]!;
    assert.equal(keyOf(second), keyOf(first), 'same key on retry');
    assert.equal(second.body.messages.at(-1).content, 'hello');
    assert.equal(users(client.getState()).length, 1, 'retry does not append a second user message');
    assert.equal(users(client.getState())[0]!.id, failedItem.id, 'the original item keeps its id and place');
  });

  it('A8: two quick Retry clicks produce ONE request', async () => {
    let runs = 0;
    const { server, client } = make((req) => {
      if (req.action !== 'run') return controlResponse(req.body, { accepted: true });
      runs++;
      return runs === 1 ? jsonError(502, 'Bad gateway') : 'stream';
    });
    await client.send('hello');
    const id = users(client.getState())[0]!.id;
    void retryOf(client)(id);
    void retryOf(client)(id);
    await tick(30);
    assert.equal(server.requests.filter((r) => r.action === 'run').length, 2, '1 original + exactly 1 retry (base: retry() missing → RED)');
  });

  it('A4: Retry on another model sends the chosen model, keeps the same key, and does not duplicate the message', async () => {
    let runs = 0;
    const { server, client } = make((req) => {
      if (req.action !== 'run') return controlResponse(req.body, { accepted: true });
      runs++;
      return runs === 1 ? jsonError(502, 'Bad gateway') : 'stream';
    });
    await client.send('hello');
    const item = users(client.getState())[0]!;
    void retryOf(client)(item.id, { model: { providerId: 'prov-b', modelId: 'model-b' } });
    await until(() => server.requests.length === 2, 2000, 'retry sent');
    const wire = server.requests[1]!.body.forwardedProps?.tourbillon;
    assert.deepEqual(wire?.modelOverride, { providerId: 'prov-b', modelId: 'model-b' });
    assert.equal(wire?.clientMessageId, keyOf(server.requests[0]!));
    assert.equal(users(client.getState()).length, 1);
  });
});

describe('TB-364 seed: reconcile a stored copy with a failed local item (pure, chat-state + thread-history)', () => {
  it('A6: the server DID store the message (client timed out): the stored copy and the failed local item collapse to ONE delivered bubble, matched by clientMessageId', () => {
    const stored = chatItemsFromStoredMessages([
      { id: 'srv-1', role: 'user', content: { format: 2, parts: [{ type: 'text', text: 'hello' }], metadata: { clientMessageId: 'key-1' } } },
    ]);
    assert.equal((stored[0] as { clientMessageId?: string }).clientMessageId, 'key-1', 'stored key surfaces on the item (base: dropped → RED)');
    const local = {
      ...initialAgentChatState,
      items: [{ kind: 'user', id: 'c1', text: 'hello', mode: 'run', delivery: 'failed', clientMessageId: 'key-1' }],
    } as unknown as AgentChatState;
    const merged = mergeHistory(local, stored);
    const u = merged.items.filter((i) => i.kind === 'user');
    assert.equal(u.length, 1, 'base: [srv-1:delivered, c1:failed] — two bubbles (probe 26 Nov) → RED');
    assert.equal((u[0] as { delivery: string }).delivery, 'delivered');
  });
});

describe('TB-364 seed: head-of-line wait and Discard (PM Q1, Q2)', () => {
  it('A12/A13: a later send while m1 is failed does not start a model turn (head-of-line)', async () => {
    let runs = 0;
    const { server, client } = make((req) => {
      if (req.action !== 'run') return controlResponse(req.body, { accepted: true });
      runs++;
      // First send fails; a second run would be accepted if head-of-line were broken (base does this).
      return runs === 1 ? jsonError(502, 'Bad gateway') : 'stream';
    });
    await client.send('first');
    assert.equal(users(client.getState())[0]!.delivery, 'failed');
    const runsBefore = server.requests.filter((r) => r.action === 'run').length;
    await client.send('second');
    const runsAfter = server.requests.filter((r) => r.action === 'run').length;
    assert.equal(runsAfter, runsBefore, 'm2 did not start a model turn while m1 is failed (base: starts a second run → RED)');
    const u = users(client.getState());
    assert.equal(u.length, 2, 'm2 is accepted into the thread');
    const second = u.find((i) => i.text === 'second')!;
    assert.ok(second, 'm2 is present');
    assert.ok(!['delivered', 'sending', 'failed'].includes(second.delivery), `m2 waits behind m1, delivery=${second.delivery}`);
  });

  it('A14/A35: Discard keeps the message in the thread marked discarded / not-sent; Retry on it is refused', async () => {
    const { server, client } = make((req) =>
      req.action === 'run' ? jsonError(502, 'Bad gateway') : controlResponse(req.body, { accepted: true }),
    );
    await client.send('hello');
    const item = users(client.getState())[0]!;
    assert.equal(item.delivery, 'failed');
    assert.equal(typeof (client as unknown as { discard?: unknown }).discard, 'function', 'discard() exists (base: absent → RED)');
    await Promise.resolve(discardOf(client)(item.id));
    const u = users(client.getState());
    assert.equal(u.length, 1, 'discarded message does not vanish');
    assert.equal(u[0]!.id, item.id);
    assert.equal(u[0]!.delivery, 'discarded', 'greyed / not sent (data-delivery=discarded)');
    const n = server.requests.length;
    try {
      await Promise.resolve(retryOf(client)(item.id));
    } catch {
      /* refusal may throw; that is fine so long as no request goes out */
    }
    await tick(30);
    assert.equal(server.requests.length, n, 'retry of a discarded message produces zero requests');
  });
});
