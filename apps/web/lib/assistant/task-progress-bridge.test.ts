/**
 * CONCIERGE-QUEUE-SIGNAL bridge wiring tests (soft-pack S1): the deliver policy (session
 * lookup, idle-thread retarget, busy-skip) and the subscriber loop
 * (startTaskProgressSignalBridge: channel/type filtering, single-consumer claim wiring,
 * error swallowing, per-process idempotence) — all against fakes, no redis/db/chat imports.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTaskProgressBridgeDeps,
  createDeliver,
  startTaskProgressSignalBridge,
  __resetTaskProgressSignalBridgeForTests,
  TASK_PROGRESS_CLAIM_TTL_SECONDS,
  type BridgeSubscriber,
  type DeliverDeps,
  type DeliverSession,
} from './task-progress-bridge';
import {
  handleTaskProgressEvent,
  taskProgressClaimKey,
  type TaskProgressAgentRecord,
  type TaskProgressEvent,
} from './task-progress-signals';
import type { TaskProgressSignalPayload } from '@tourbillon/mastra/concierge-signal';

const AGENT: TaskProgressAgentRecord = {
  id: 'agent-1',
  companyId: 'company-1',
  status: 'active',
  companyStatus: 'active',
};

const PAYLOAD: TaskProgressSignalPayload = {
  tagName: 'task-progress',
  attributes: { taskId: 'task-1', runId: 'run-1', stage: 'started', status: 'running' },
  contents: 'Background task started: "Ship the runbook". Progress updates will follow.',
};

function progressEvent(over: Partial<TaskProgressEvent> = {}): TaskProgressEvent {
  return {
    companyId: 'company-1',
    agentId: 'agent-1',
    chatTaskId: 'task-1',
    runId: 'run-1',
    stage: 'started',
    status: 'running',
    title: 'Ship the runbook',
    ...over,
  };
}

// ─── createDeliver: the session policy (S1) ─────────────────────────────────────────────

class FakeThread {
  switched: string[] = [];
  constructor(private id: string | null) {}
  getId(): string | null {
    return this.id;
  }
  async switch({ threadId }: { threadId: string }): Promise<void> {
    this.switched.push(threadId);
    this.id = threadId;
  }
}

class FakeSession implements DeliverSession {
  thread: FakeThread;
  signals: Array<{ type: string; tagName?: string; contents: string; id?: string }> = [];
  runId: string | null = null;
  constructor(threadId: string | null) {
    this.thread = new FakeThread(threadId);
  }
  getCurrentRunId(): string | null {
    return this.runId;
  }
  queueSignal(signal: { type: 'reactive'; tagName?: string; contents: string; id?: string }): Promise<void> {
    this.signals.push(signal as never);
    return Promise.resolve();
  }
}

function deliverHarness(opts: { existing?: FakeSession | null } = {}) {
  const created: Array<{ resourceId: string; scope: string; threadId: string }> = [];
  const lookups: Array<{ resourceId: string; scope: string }> = [];
  const deps: DeliverDeps = {
    resourceId: (agent) => `res:${agent.companyId}`,
    getOrCreateChatController: async () => ({
      getSessionByResource: async (resourceId, scope) => {
        lookups.push({ resourceId, scope });
        return opts.existing ?? null;
      },
    }),
    getChatSession: async (_controller, _agent, o) => {
      created.push(o);
      return new FakeSession(o.threadId);
    },
  };
  return { deliver: createDeliver(deps), created, lookups };
}

test('deliver: no session on the resource → created on the pinned free-chat thread and queued', async () => {
  const h = deliverHarness({ existing: null });
  assert.equal(await h.deliver(AGENT, 'thread-42', PAYLOAD), true);
  assert.deepEqual(h.lookups, [{ resourceId: 'res:company-1', scope: 'agui:agent-1' }]);
  assert.deepEqual(h.created, [{ resourceId: 'res:company-1', scope: 'agui:agent-1', threadId: 'thread-42' }]);
  // The signal reached the freshly created session as a typed reactive signal.
});

test('deliver: session already on the pinned thread → queued in place (no create, no switch)', async () => {
  const existing = new FakeSession('thread-42');
  const h = deliverHarness({ existing });
  assert.equal(await h.deliver(AGENT, 'thread-42', PAYLOAD), true);
  assert.deepEqual(h.created, []);
  assert.deepEqual(existing.thread.switched, []);
  assert.equal(existing.signals.length, 1);
  assert.equal((existing.signals[0] as { type: string }).type, 'reactive');
  assert.equal(existing.signals[0]!.tagName, 'task-progress');
});

test('deliver: idle session parked on another thread → retargeted to the pinned thread (S1)', async () => {
  const existing = new FakeSession('thread-OLD');
  const h = deliverHarness({ existing });
  assert.equal(await h.deliver(AGENT, 'thread-42', PAYLOAD), true);
  assert.deepEqual(existing.thread.switched, ['thread-42']);
  assert.deepEqual(h.created, [], 'the existing session is reused, not recreated');
  assert.equal(existing.signals.length, 1);
});

test('deliver: session BUSY on another thread → skipped, never hijacked (S1)', async () => {
  const existing = new FakeSession('thread-OLD');
  existing.runId = 'run-live';
  const h = deliverHarness({ existing });
  assert.equal(await h.deliver(AGENT, 'thread-42', PAYLOAD), false);
  assert.deepEqual(existing.thread.switched, [], 'a live run\'s thread must not be switched');
  assert.equal(existing.signals.length, 0, 'nothing queued behind the live run');
  assert.deepEqual(h.created, []);
});

// ─── buildTaskProgressBridgeDeps: the claim wiring (S2) ──────────────────────────────────

test('deps: claimEvent uses the stable claim key with the bridge TTL', async () => {
  const seen: Array<{ key: string; ttl: number }> = [];
  const deps = buildTaskProgressBridgeDeps({
    claimClient: {
      claim: async (key, ttl) => {
        seen.push({ key, ttl });
        return true;
      },
    },
  });
  assert.equal(await deps.claimEvent(progressEvent()), true);
  assert.deepEqual(seen, [
    { key: 'concierge-signal:seen:company-1:task-1:run-1:started', ttl: TASK_PROGRESS_CLAIM_TTL_SECONDS },
  ]);
});

test('deps: two replicas over ONE claim client — only the first gets deliver', async () => {
  const store = new Set<string>();
  const sharedClaim = { claim: async (key: string) => (store.has(key) ? false : (store.add(key), true)) };
  const replicaA = buildTaskProgressBridgeDeps({
    claimClient: sharedClaim,
    getAgent: async () => AGENT,
    getActiveThreadId: async () => 'thread-42',
    deliver: async () => true,
    log: { warn: () => {} },
  });
  const replicaB = buildTaskProgressBridgeDeps({
    claimClient: sharedClaim,
    getAgent: async () => AGENT,
    getActiveThreadId: async () => 'thread-42',
    deliver: async () => true,
    log: { warn: () => {} },
  });
  assert.equal(await handleTaskProgressEvent(replicaA, progressEvent()), 'queued');
  assert.equal(await handleTaskProgressEvent(replicaB, progressEvent()), 'skipped:duplicate');
});

// ─── startTaskProgressSignalBridge: the subscriber loop (S1) ─────────────────────────────

class FakeSubscriber implements BridgeSubscriber {
  patterns: string[] = [];
  subscribeErrors = 0;
  private listener?: (pattern: string, channel: string, message: string) => void;
  on(_event: 'pmessage', listener: (pattern: string, channel: string, message: string) => void): void {
    this.listener = listener;
  }
  async psubscribe(pattern: string): Promise<void> {
    this.patterns.push(pattern);
  }
  emit(channel: string, message: string): void {
    this.listener?.('sse:*', channel, message);
  }
}

const idleDeliver = async (
  _agent: TaskProgressAgentRecord,
  _threadId: string,
  _payload: TaskProgressSignalPayload,
): Promise<boolean> => true;

function bridgeOptions(
  sub: FakeSubscriber,
  opts: {
    deliver?: (
      agent: TaskProgressAgentRecord,
      threadId: string,
      payload: TaskProgressSignalPayload,
    ) => Promise<boolean>;
  } = {},
) {
  return {
    createSubscriber: () => sub,
    claimClient: { claim: async () => true },
    getAgent: async () => AGENT,
    getActiveThreadId: async () => 'thread-42',
    deliver: opts.deliver ?? idleDeliver,
    log: { warn: () => {} },
  };
}

async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r));
}

test('bridge: subscribes sse:* and routes only valid chat_task_progress events on sse: channels', async () => {
  __resetTaskProgressSignalBridgeForTests();
  const sub = new FakeSubscriber();
  const routed: Array<{ threadId: string; contents: string }> = [];
  startTaskProgressSignalBridge(
    bridgeOptions(sub, {
      deliver: async (_a, threadId, payload) => {
        routed.push({ threadId, contents: payload.contents });
        return true;
      },
    }),
  );
  assert.deepEqual(sub.patterns, ['sse:*']);

  // Ignored: non-sse channel, garbage, foreign SSE type.
  sub.emit('sse-not-this', JSON.stringify({ type: 'chat_task_progress', ...progressEvent() }));
  sub.emit('sse:company-1', 'not json');
  sub.emit('sse:company-1', JSON.stringify({ type: 'issue_updated', ...progressEvent() }));
  await flush();
  assert.equal(routed.length, 0, 'only chat_task_progress on sse:* channels may route');

  sub.emit('sse:company-1', JSON.stringify({ type: 'chat_task_progress', ...progressEvent() }));
  await flush();
  assert.equal(routed.length, 1);
  assert.equal(routed[0]!.threadId, 'thread-42');
  assert.match(routed[0]!.contents, /^Background task started: "Ship the runbook"\./);
});

test('bridge: a rejected deliver is swallowed with a warn — the subscriber loop never throws', async () => {
  __resetTaskProgressSignalBridgeForTests();
  const sub = new FakeSubscriber();
  const warn = console.warn;
  const logged: unknown[] = [];
  console.warn = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    startTaskProgressSignalBridge(
      bridgeOptions(sub, {
        deliver: async () => {
          throw new Error('controller exploded');
        },
      }),
    );
    sub.emit('sse:company-1', JSON.stringify({ type: 'chat_task_progress', ...progressEvent() }));
    await flush();
    assert.match(JSON.stringify(logged), /controller exploded/);
  } finally {
    console.warn = warn;
  }
});

test('bridge: idempotent per process; the reset hook restarts it (S1)', async () => {
  __resetTaskProgressSignalBridgeForTests();
  const subs: FakeSubscriber[] = [];
  const make = () => {
    const s = new FakeSubscriber();
    subs.push(s);
    return s;
  };
  startTaskProgressSignalBridge({ ...bridgeOptions(new FakeSubscriber()), createSubscriber: make });
  startTaskProgressSignalBridge({ ...bridgeOptions(new FakeSubscriber()), createSubscriber: make });
  assert.equal(subs.length, 1, 'the second start must not open a second subscriber');

  __resetTaskProgressSignalBridgeForTests();
  startTaskProgressSignalBridge({ ...bridgeOptions(new FakeSubscriber()), createSubscriber: make });
  assert.equal(subs.length, 2, 'after the reset the bridge opens a fresh subscriber');
  assert.deepEqual(subs[1]!.patterns, ['sse:*']);
  __resetTaskProgressSignalBridgeForTests();
});
