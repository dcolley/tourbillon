/**
 * CONCIERGE-QUEUE-SIGNAL bridge wiring tests (soft-pack S1, softs S10–S12): the deliver
 * policy (session lookup, idle-thread retarget, busy-skip, signal lands on the created
 * session), the subscriber loop (startTaskProgressSignalBridge: channel/type filtering,
 * single-consumer claim wiring, error swallowing, per-process idempotence), the db-backed
 * getAgent company join (S10) and the fail-open redis claim (S11) — all against fakes, no
 * real redis/db/chat imports.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTaskProgressBridgeDeps,
  createDeliver,
  getAgent,
  redisClaimClient,
  startTaskProgressSignalBridge,
  __resetTaskProgressSignalBridgeForTests,
  TASK_PROGRESS_CLAIM_TTL_SECONDS,
  type BridgeSubscriber,
  type DeliverDeps,
  type DeliverSession,
  type RedisClaimCommands,
  type TaskProgressDbQuery,
  type TaskProgressOrm,
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
  const createdSessions: FakeSession[] = [];
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
      const session = new FakeSession(o.threadId);
      createdSessions.push(session);
      return session;
    },
  };
  return { deliver: createDeliver(deps), created, createdSessions, lookups };
}

test('deliver: no session on the resource → created on the pinned free-chat thread and queued', async () => {
  const h = deliverHarness({ existing: null });
  assert.equal(await h.deliver(AGENT, 'thread-42', PAYLOAD), true);
  assert.deepEqual(h.lookups, [{ resourceId: 'res:company-1', scope: 'agui:agent-1' }]);
  assert.deepEqual(h.created, [{ resourceId: 'res:company-1', scope: 'agui:agent-1', threadId: 'thread-42' }]);
  // S12: the signal must provably reach the FRESHLY CREATED session, not just be "queued".
  assert.equal(h.createdSessions.length, 1, 'exactly one session created');
  const session = h.createdSessions[0]!;
  assert.equal(session.signals.length, 1, 'the typed signal reached the created session');
  const signal = session.signals[0] as Record<string, unknown>;
  assert.equal(signal.type, 'reactive');
  assert.equal(signal.tagName, 'task-progress');
  assert.equal(signal.contents, PAYLOAD.contents);
  assert.deepEqual(signal.attributes, PAYLOAD.attributes);
  assert.equal(typeof signal.id, 'string', 'queueConciergeSignal assigns a cancel-able id');
  assert.equal(session.thread.getId(), 'thread-42', 'the created session is on the pinned thread');
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

// ─── getAgent: the REAL db-backed company join (softs S10) ──────────────────────────────
//
// The pure core already skips inactive tenants, but until now the db-backed `getAgent` was
// never exercised: hard-coding `companyStatus: 'active'` in its mapper kept every test green.
// These inject a fake db query + orm so the join, the company lookup BY THE AGENT'S companyId,
// and the companyStatus mapping itself are load-bearing.

function fakeOrm(): { orm: TaskProgressOrm; where: unknown[] } {
  const where: unknown[] = [];
  return {
    orm: {
      eq: (column, value) => {
        const marker = { column, value };
        where.push(marker);
        return marker;
      },
    },
    where,
  };
}

function fakeDb(opts: {
  agent?: { id: string; companyId: string; status: string };
  company?: { status: string };
}): { query: TaskProgressDbQuery; agentLookups: unknown[]; companyLookups: unknown[] } {
  const agentLookups: unknown[] = [];
  const companyLookups: unknown[] = [];
  return {
    agentLookups,
    companyLookups,
    query: {
      agents: {
        findFirst: async (args) => {
          agentLookups.push(args);
          return opts.agent;
        },
      },
      companies: {
        findFirst: async (args) => {
          companyLookups.push(args);
          return opts.company;
        },
      },
    },
  };
}

test('getAgent (db-backed, S10): joins the company row and maps companyStatus through — NOT hard-coded active', async () => {
  const db = fakeDb({
    agent: { id: 'agent-1', companyId: 'company-9', status: 'active' },
    company: { status: 'paused' },
  });
  const orm = fakeOrm();
  const rec = await getAgent('agent-1', { db, orm: orm.orm });
  // companyStatus is the JOINED company row's status. Flip the mapper to
  // `companyStatus: 'active'` and this fails even though the pure core still skips later —
  // the bridge must see the real tenant state, not a stubbed one.
  assert.deepEqual(rec, { id: 'agent-1', companyId: 'company-9', status: 'active', companyStatus: 'paused' });
  // The company is looked up BY THE AGENT'S companyId (real join), not the requested id.
  assert.equal(db.agentLookups.length, 1, 'one agent lookup');
  assert.equal(db.companyLookups.length, 1, 'one company lookup (the join)');
  assert.deepEqual(orm.where, [
    { column: undefined, value: 'agent-1' }, // eq(agents.id, agentId)
    { column: undefined, value: 'company-9' }, // eq(companies.id, row.companyId)
  ]);
});

test('getAgent (db-backed, S10): missing agent row → null, company join never runs', async () => {
  const db = fakeDb({ company: { status: 'active' } });
  const orm = fakeOrm();
  assert.equal(await getAgent('ghost', { db, orm: orm.orm }), null);
  assert.deepEqual(db.companyLookups, [], 'no company join for a missing agent');
});

test('getAgent (db-backed, S10): missing company row → null (no tenant to deliver into)', async () => {
  const db = fakeDb({ agent: { id: 'agent-1', companyId: 'company-9', status: 'active' } });
  const orm = fakeOrm();
  assert.equal(await getAgent('agent-1', { db, orm: orm.orm }), null);
  assert.equal(db.companyLookups.length, 1, 'the company was looked up before deciding');
});

test('getAgent (db-backed, S10): through buildTaskProgressBridgeDeps — a paused tenant never reaches deliver', async () => {
  // Full-bridge proof with the REAL getAgent (default wiring path): only the injected db
  // differs from production. Stubbing companyStatus:'active' here would flip this to 'queued'.
  const db = fakeDb({
    agent: { id: 'agent-1', companyId: 'company-1', status: 'active' },
    company: { status: 'archived' },
  });
  const orm = fakeOrm();
  let delivered = 0;
  const deps = buildTaskProgressBridgeDeps({
    claimClient: { claim: async () => true },
    getAgent: (agentId) => getAgent(agentId, { db, orm: orm.orm }),
    getActiveThreadId: async () => 'thread-42',
    deliver: async () => {
      delivered += 1;
      return true;
    },
    log: { warn: () => {} },
  });
  assert.equal(await handleTaskProgressEvent(deps, progressEvent()), 'skipped:inactive');
  assert.equal(delivered, 0, 'an archived tenant must not be woken into an LLM turn');
  assert.equal(db.companyLookups.length, 1);
});

// ─── redisClaimClient: fail-open on redis errors (softs S11) ─────────────────────────────
//
// The claim is at-least-once by design: a redis failure must NOT drop the notification on
// every replica. Flip the catch to `return false` (fail closed) and these fail.

function fakeClaimClient(behaviour: { results?: Array<'OK' | null>; error?: Error }): RedisClaimCommands & {
  calls: Array<{ key: string; value: string; ttl: number; mode: string; nx: string }>;
} {
  const calls: Array<{ key: string; value: string; ttl: number; mode: string; nx: string }> = [];
  let i = 0;
  return {
    calls,
    set: async (key, value, mode, ttl, nx) => {
      calls.push({ key, value, ttl, mode, nx });
      if (behaviour.error) throw behaviour.error;
      const results = behaviour.results ?? ['OK'];
      return results[Math.min(i++, results.length - 1)] ?? null;
    },
  };
}

async function captureWarns<T>(run: () => Promise<T>): Promise<{ result: T; logged: Array<{ msg: string; data?: unknown }> }> {
  const original = console.warn;
  const logged: Array<{ msg: string; data?: unknown }> = [];
  console.warn = (msg?: unknown, data?: unknown) => {
    logged.push({ msg: String(msg), data });
  };
  try {
    const result = await run();
    return { result, logged };
  } finally {
    console.warn = original;
  }
}

test('redisClaimClient: SET NX EX contract — first claim true, key already held false (S11)', async () => {
  const client = fakeClaimClient({ results: ['OK', null] });
  const claim = redisClaimClient(client);
  assert.equal(await claim.claim('k1', 900), true);
  assert.equal(await claim.claim('k1', 900), false, 'SET NX returns nil when another replica holds the key');
  assert.deepEqual(client.calls, [
    { key: 'k1', value: '1', ttl: 900, mode: 'EX', nx: 'NX' },
    { key: 'k1', value: '1', ttl: 900, mode: 'EX', nx: 'NX' },
  ]);
});

test('redisClaimClient: a rejected SET fails OPEN (claim true + warn), never drops (S11)', async () => {
  const client = fakeClaimClient({ error: new Error('ECONNREFUSED') });
  const claim = redisClaimClient(client);
  const { result, logged } = await captureWarns(() =>
    claim.claim(taskProgressClaimKey(progressEvent()), TASK_PROGRESS_CLAIM_TTL_SECONDS),
  );
  assert.equal(result, true, 'fail OPEN: redis down must not silence every replica');
  assert.equal(logged.length, 1, 'the fallback is loud, not silent');
  assert.match(logged[0]!.msg, /claim failed; delivering anyway/);
  assert.deepEqual(logged[0]!.data, {
    key: 'concierge-signal:seen:company-1:task-1:run-1:started',
    error: 'ECONNREFUSED',
  });
});

test('redisClaimClient: redis down end-to-end — the event is still claimed AND delivered (S11)', async () => {
  // The bridge's real failure mode: redis unreachable → every replica must still deliver
  // (at-least-once), not collectively drop the notification. Fail-closed catch → 'skipped:duplicate'.
  const client = fakeClaimClient({ error: new Error('READONLY You can’t write against a read only replica.') });
  const delivered: string[] = [];
  const deps = buildTaskProgressBridgeDeps({
    claimClient: redisClaimClient(client),
    getAgent: async () => AGENT,
    getActiveThreadId: async () => 'thread-42',
    deliver: async (_a, threadId) => {
      delivered.push(threadId);
      return true;
    },
    log: { warn: () => {} },
  });
  const { result: outcome, logged } = await captureWarns(() => handleTaskProgressEvent(deps, progressEvent()));
  assert.equal(outcome, 'queued', 'a redis outage must not drop the notification (fail open)');
  assert.deepEqual(delivered, ['thread-42'], 'the signal still reaches deliver');
  assert.equal(client.calls.length, 1);
  assert.ok(
    logged.some((w) => /claim failed; delivering anyway/.test(w.msg)),
    'the fail-open fallback was logged',
  );
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
