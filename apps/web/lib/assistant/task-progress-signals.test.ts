/**
 * CONCIERGE-QUEUE-SIGNAL bridge tests: SSE payload → typed signal routing (parse guards,
 * agent/company/thread resolution, and the deliver path against a fake Mastra queue session
 * — idle wakes, active waits, attributes preserved, cancel by id).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  handleTaskProgressEvent,
  parseTaskProgressMessage,
  queueTaskProgressSignal,
  taskProgressClaimKey,
  TASK_PROGRESS_SSE_TYPE,
  type TaskProgressAgentRecord,
  type TaskProgressBridgeDeps,
  type TaskProgressEvent,
} from './task-progress-signals';
import { TASK_PROGRESS_SSE_TYPE as SHARED_TASK_PROGRESS_SSE_TYPE } from '@tourbillon/shared/types';
import {
  cancelQueuedConciergeSignals,
  type TaskProgressSignalPayload,
} from '@tourbillon/mastra/concierge-signal';

function event(over: Partial<TaskProgressEvent> = {}): TaskProgressEvent {
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

// ─── parseTaskProgressMessage ────────────────────────────────────────────────

test('parse: valid chat_task_progress payload round-trips', () => {
  const raw = JSON.stringify({ type: 'chat_task_progress', ...event() });
  assert.deepEqual(parseTaskProgressMessage(raw), event());
});

test('parse: non-JSON, other types, bad stage/status and missing fields return null', () => {
  assert.equal(parseTaskProgressMessage('not json'), null);
  assert.equal(parseTaskProgressMessage(JSON.stringify({ type: 'issue_updated', ...event() })), null);
  assert.equal(parseTaskProgressMessage(JSON.stringify({ type: 'chat_task_progress', ...event(), stage: 'weird' })), null);
  assert.equal(parseTaskProgressMessage(JSON.stringify({ type: 'chat_task_progress', ...event(), status: 'weird' })), null);
  assert.equal(parseTaskProgressMessage(JSON.stringify({ type: 'chat_task_progress', ...event(), title: '' })), null);
  assert.equal(parseTaskProgressMessage(JSON.stringify({ type: 'chat_task_progress', ...event(), runId: null })), null);
  assert.equal(parseTaskProgressMessage('42'), null);
});

// ─── handleTaskProgressEvent routing ─────────────────────────────────────────

interface Harness {
  deps: TaskProgressBridgeDeps<TaskProgressAgentRecord>;
  delivered: Array<{ agentId: string; threadId: string; payload: TaskProgressSignalPayload }>;
  claimed: string[];
  warnings: Array<{ msg: string; data?: Record<string, unknown> }>;
}

function harness(opts: {
  agent?: TaskProgressAgentRecord | null;
  threadId?: string | null;
  deliverOk?: boolean;
  /** Shared across harnesses to emulate several replicas seeing one event (S2). */
  claimStore?: Set<string>;
} = {}): Harness {
  const delivered: Harness['delivered'] = [];
  const claimed: string[] = [];
  const warnings: Harness['warnings'] = [];
  return {
    delivered,
    claimed,
    warnings,
    deps: {
      getAgent: async () =>
        'agent' in opts
          ? (opts.agent ?? null)
          : { id: 'agent-1', companyId: 'company-1', status: 'active', companyStatus: 'active' },
      getActiveThreadId: async () => ('threadId' in opts ? (opts.threadId ?? null) : 'thread-42'),
      deliver: async (agent, threadId, payload) => {
        delivered.push({ agentId: agent.id, threadId, payload });
        return opts.deliverOk !== false;
      },
      claimEvent: async (event) => {
        const key = taskProgressClaimKey(event);
        claimed.push(key);
        if (!opts.claimStore) return true;
        if (opts.claimStore.has(key)) return false;
        opts.claimStore.add(key);
        return true;
      },
      log: { warn: (msg, data) => warnings.push({ msg, data }) },
    },
  };
}

test('handle: started event is queued onto the pinned free-chat thread', async () => {
  const h = harness();
  const result = await handleTaskProgressEvent(h.deps, event());
  assert.equal(result, 'queued');
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0]!.threadId, 'thread-42');
  assert.equal(h.delivered[0]!.payload.tagName, 'task-progress');
  assert.match(h.delivered[0]!.payload.contents, /^Background task started: "Ship the runbook"\./);
  assert.deepEqual(h.delivered[0]!.payload.attributes, {
    taskId: 'task-1',
    runId: 'run-1',
    stage: 'started',
    status: 'running',
  });
});

test('handle: status→contents — done, failed (another look), skipped (decision)', async () => {
  const cases: Array<[Partial<TaskProgressEvent>, RegExp]> = [
    [{ stage: 'done', status: 'succeeded' }, /^Background task done:/],
    [{ stage: 'needs_review', status: 'failed' }, /needs another look/],
    [{ stage: 'needs_review', status: 'skipped' }, /needs a decision/],
  ];
  for (const [over, pattern] of cases) {
    const h = harness();
    assert.equal(await handleTaskProgressEvent(h.deps, event(over)), 'queued');
    assert.match(h.delivered[0]!.payload.contents, pattern);
  }
});

test('handle: unknown agent is skipped (no signal anywhere)', async () => {
  const h = harness({ agent: null });
  assert.equal(await handleTaskProgressEvent(h.deps, event()), 'skipped:no-agent');
  assert.equal(h.delivered.length, 0);
});

test('handle: agent from another company is skipped', async () => {
  const h = harness({
    agent: { id: 'agent-1', companyId: 'company-OTHER', status: 'active', companyStatus: 'active' },
  });
  assert.equal(await handleTaskProgressEvent(h.deps, event()), 'skipped:company-mismatch');
  assert.equal(h.delivered.length, 0);
});

test('handle: agent with no pinned chat thread is skipped (nothing to wake)', async () => {
  const h = harness({ threadId: null });
  assert.equal(await handleTaskProgressEvent(h.deps, event()), 'skipped:no-thread');
  assert.equal(h.delivered.length, 0);
});

test('handle: unavailable session reports skipped:no-session, never throws', async () => {
  const h = harness({ deliverOk: false });
  assert.equal(await handleTaskProgressEvent(h.deps, event()), 'skipped:no-session');
});

// ─── deliver path: the shared Mastra queue semantics (emulated contract) ─────

interface QueuedSignal {
  type: string;
  tagName?: string;
  attributes?: Record<string, unknown>;
  contents: string;
  id?: string;
}

class FakeChatSession {
  busy = false;
  queued: QueuedSignal[] = [];
  delivered: QueuedSignal[] = [];
  interrupts: string[] = [];

  queueSignal(signal: QueuedSignal): Promise<void> {
    if (this.busy) this.queued.push(signal);
    else this.delivered.push(signal);
    return Promise.resolve();
  }
  // A live run must never be interrupted for routine progress (product lock).
  sendMessage(): void {
    this.interrupts.push('sendMessage');
  }
  steer(): void {
    this.interrupts.push('steer');
  }
  sendSignal(): void {
    this.interrupts.push('sendSignal');
  }

  startRun(): void {
    this.busy = true;
  }
  finishRun(): void {
    this.busy = false;
    this.delivered.push(...this.queued.splice(0, this.queued.length));
  }
}

test('deliver: idle session wakes now; a live chat run waits, then gets the typed signal', async () => {
  const h = harness();
  const session = new FakeChatSession();

  // Someone is chatting: a run is live.
  session.startRun();
  const payload = {
    tagName: 'task-progress',
    attributes: { taskId: 'task-1', runId: 'run-1', stage: 'done', status: 'succeeded' },
    contents: 'Background task done: "Ship the runbook".',
  };
  const signalId = await queueTaskProgressSignal(session, payload);
  assert.equal(session.delivered.length, 0, 'must not interrupt the live run');
  assert.equal(session.queued.length, 1);
  assert.deepEqual(session.interrupts, []);

  session.finishRun();
  assert.equal(session.delivered.length, 1);
  const signal = session.delivered[0]!;
  assert.equal(signal.type, 'reactive');
  assert.equal(signal.tagName, 'task-progress');
  assert.equal(signal.attributes!.taskId, 'task-1');
  assert.equal(signal.id, signalId);

  // User dismisses the queued follow-up before the next turn: cancel by id.
  session.startRun();
  const queuedAgain = queueTaskProgressSignal(session, payload);
  void queuedAgain;
  const cancelled = await cancelQueuedConciergeSignals(
    {
      cancelQueuedMessages: (t) => ({ cancelledSignalIds: [...t.signalIds] }),
    },
    { resourceId: 'company-company-1:chat:free', threadId: 'thread-42', signalIds: [signalId] },
  );
  assert.deepEqual(cancelled, [signalId]);
});

test('deliver: handleTaskProgressEvent end-to-end onto the fake chat session', async () => {
  const session = new FakeChatSession();
  const deps: TaskProgressBridgeDeps<TaskProgressAgentRecord> = {
    getAgent: async () => ({ id: 'agent-1', companyId: 'company-1', status: 'active', companyStatus: 'active' }),
    getActiveThreadId: async () => 'thread-42',
    deliver: async (_agent, _thread, payload) => {
      await queueTaskProgressSignal(session, payload);
      return true;
    },
    claimEvent: async () => true,
  };
  assert.equal(await handleTaskProgressEvent(deps, event()), 'queued');
  assert.equal(await handleTaskProgressEvent(deps, event({ stage: 'done', status: 'succeeded' })), 'queued');
  assert.equal(session.delivered.length, 2);
  assert.deepEqual(
    session.delivered.map((s) => s.attributes!.stage),
    ['started', 'done'],
  );
});

// ─── S2: single-consumer claim across web replicas ──────────────────────────

test('claim: every replica sees the event; only the first claimer delivers', async () => {
  const claimStore = new Set<string>();
  const raw = JSON.stringify({ type: 'chat_task_progress', ...event() });
  const parsed = parseTaskProgressMessage(raw)!;

  const replicaA = harness({ claimStore });
  const replicaB = harness({ claimStore });
  assert.equal(await handleTaskProgressEvent(replicaA.deps, parsed), 'queued');
  assert.equal(await handleTaskProgressEvent(replicaB.deps, parsed), 'skipped:duplicate');
  assert.equal(replicaA.delivered.length, 1);
  assert.equal(replicaB.delivered.length, 0, 'the second replica must NOT queue a duplicate signal');
  // A different stage of the same run is a different notification — not a duplicate.
  assert.equal(
    await handleTaskProgressEvent(replicaB.deps, event({ stage: 'done', status: 'succeeded' })),
    'queued',
  );
});

test('claim: the key pins (companyId, chatTaskId, runId, stage) — stable across replicas', () => {
  assert.equal(
    taskProgressClaimKey(event()),
    'concierge-signal:seen:company-1:task-1:run-1:started',
  );
  // Same transition, differently-derived event → same key (that is the whole point).
  const parsed = parseTaskProgressMessage(JSON.stringify({ type: 'chat_task_progress', ...event() }))!;
  assert.equal(taskProgressClaimKey(parsed), taskProgressClaimKey(event()));
  // Any component differs → different key.
  assert.notEqual(taskProgressClaimKey(event({ runId: 'run-2' })), taskProgressClaimKey(event()));
  assert.notEqual(
    taskProgressClaimKey(event({ stage: 'done', status: 'succeeded' })),
    taskProgressClaimKey(event()),
  );
});

test('claim: claimed before any db work (getAgent untouched on duplicate)', async () => {
  const claimStore = new Set<string>([taskProgressClaimKey(event())]);
  let agentLookups = 0;
  const h = harness({ claimStore });
  const orig = h.deps.getAgent;
  const deps: TaskProgressBridgeDeps<TaskProgressAgentRecord> = {
    ...h.deps,
    getAgent: (id) => {
      agentLookups += 1;
      return orig(id);
    },
  };
  assert.equal(await handleTaskProgressEvent(deps, event()), 'skipped:duplicate');
  assert.equal(agentLookups, 0);
});

// ─── S4: paused/archived agents and companies must not be woken ─────────────

test('inactive: paused, archived and pending_approval agents are skipped (S4, #196-B1 class)', async () => {
  for (const status of ['paused', 'archived', 'pending_approval']) {
    const h = harness({ agent: { id: 'agent-1', companyId: 'company-1', status, companyStatus: 'active' } });
    assert.equal(await handleTaskProgressEvent(h.deps, event()), 'skipped:inactive', status);
    assert.equal(h.delivered.length, 0);
    assert.equal(h.warnings.length, 1);
    assert.match(h.warnings[0]!.msg, /inactive/);
  }
});

test('inactive: paused/archived company skips even for an active agent', async () => {
  for (const companyStatus of ['paused', 'archived']) {
    const h = harness({ agent: { id: 'agent-1', companyId: 'company-1', status: 'active', companyStatus } });
    assert.equal(await handleTaskProgressEvent(h.deps, event()), 'skipped:inactive', companyStatus);
    assert.equal(h.delivered.length, 0);
  }
});

// ─── S3: documented behaviour — `started` on an idle thread wakes a full turn ──────────────

test('S3 pin: every transition (including started) queues via queueSignal; idle = immediate wake', async () => {
  // Current, deliberate behaviour: Mastra 1.78 queueSignal has no queue-without-wake option,
  // so even the low-information `started` line wakes an idle thread for one concierge turn.
  // TODO(#197 soft-pack S3): if the queue grows a non-waking enqueue, `started` should be
  // parked for the NEXT human-initiated turn instead — this test is the pin to update then.
  const idleSession = new FakeChatSession();
  await queueTaskProgressSignal(idleSession, {
    tagName: 'task-progress',
    attributes: { taskId: 'task-1', runId: 'run-1', stage: 'started', status: 'running' },
    contents: 'Background task started: "Ship the runbook". Progress updates will follow.',
  });
  assert.equal(idleSession.delivered.length, 1, 'idle thread gets the signal at once (the wake)');
  assert.equal(idleSession.queued.length, 0);
  assert.deepEqual(idleSession.interrupts, [], 'still no mid-token interrupt path used');
});

// ─── S4 (#205 softs): one source for the wire type ───────────────────────────────────────

test('S4: the bridge re-exports the SHARED constant — publisher and parser cannot drift', () => {
  // #205 soft S4: web used to define its own `satisfies`-pinned literal of 'chat_task_progress'
  // next to the shared one — two pinned copies, single-sourced nowhere. The bridge now imports
  // the shared binding; this pins the identity so a future re-fork into a local literal copy
  // (or any value drift between the two packages) goes red.
  assert.equal(TASK_PROGRESS_SSE_TYPE, SHARED_TASK_PROGRESS_SSE_TYPE);
  assert.equal(TASK_PROGRESS_SSE_TYPE, 'chat_task_progress');
  // And the parser actually routes on it (a payload typed with the shared constant parses).
  assert.deepEqual(
    parseTaskProgressMessage(JSON.stringify({ type: SHARED_TASK_PROGRESS_SSE_TYPE, ...event() })),
    event(),
  );
});

// ─── S210a (#210 softs): static source guard — the value pin above has a blind spot ──────

test('S210a: the re-export module contains no local chat_task_progress string literal — only the shared import/re-export', () => {
  // The S4 pin is value-only: a same-value local re-fork (`const TASK_PROGRESS_SSE_TYPE =
  // 'chat_task_progress' satisfies SSEEventType` next to the shared one) stays green because
  // both sides still equal 'chat_task_progress'. This static guard reads the module source and
  // asserts the wire type exists HERE only as the shared import/re-export. Mutant: add a local
  // 'chat_task_progress' literal to task-progress-signals.ts → RED.
  const src = readFileSync(fileURLToPath(new URL('./task-progress-signals.ts', import.meta.url)), 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments (the prose mentions the literal)
    .replace(/^\s*\/\/.*$/gm, ' '); // line comments
  const literal = /(['"`])chat_task_progress\1/;
  assert.ok(
    !literal.test(code),
    "task-progress-signals.ts must not define its own 'chat_task_progress' literal — " +
      'the shared TASK_PROGRESS_SSE_TYPE is the single source (import + re-export only)',
  );
  // Positive half: the shared binding really is what this module re-exports.
  assert.match(src, /import\s*\{[^}]*TASK_PROGRESS_SSE_TYPE[^}]*\}\s*from\s*'@tourbillon\/shared\/types'/);
  assert.match(src, /export\s*\{\s*TASK_PROGRESS_SSE_TYPE\s*\}/);
});
