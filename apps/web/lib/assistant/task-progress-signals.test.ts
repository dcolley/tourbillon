/**
 * CONCIERGE-QUEUE-SIGNAL bridge tests: SSE payload → typed signal routing (parse guards,
 * agent/company/thread resolution, and the deliver path against a fake Mastra queue session
 * — idle wakes, active waits, attributes preserved, cancel by id).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleTaskProgressEvent,
  parseTaskProgressMessage,
  queueTaskProgressSignal,
  type TaskProgressBridgeDeps,
  type TaskProgressEvent,
} from './task-progress-signals';
import {
  cancelQueuedConciergeSignals,
  type TaskProgressSignalPayload,
} from '../../../../packages/mastra/src/concierge-signal';

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
  deps: TaskProgressBridgeDeps<{ id: string; companyId: string }>;
  delivered: Array<{ agentId: string; threadId: string; payload: TaskProgressSignalPayload }>;
}

function harness(opts: {
  agent?: { id: string; companyId: string } | null;
  threadId?: string | null;
  deliverOk?: boolean;
} = {}): Harness {
  const delivered: Harness['delivered'] = [];
  return {
    delivered,
    deps: {
      getAgent: async () => ('agent' in opts ? (opts.agent ?? null) : { id: 'agent-1', companyId: 'company-1' }),
      getActiveThreadId: async () => ('threadId' in opts ? (opts.threadId ?? null) : 'thread-42'),
      deliver: async (agent, threadId, payload) => {
        delivered.push({ agentId: agent.id, threadId, payload });
        return opts.deliverOk !== false;
      },
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
  const h = harness({ agent: { id: 'agent-1', companyId: 'company-OTHER' } });
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
  const deps: TaskProgressBridgeDeps<{ id: string; companyId: string }> = {
    getAgent: async () => ({ id: 'agent-1', companyId: 'company-1' }),
    getActiveThreadId: async () => 'thread-42',
    deliver: async (_agent, _thread, payload) => {
      await queueTaskProgressSignal(session, payload);
      return true;
    },
  };
  assert.equal(await handleTaskProgressEvent(deps, event()), 'queued');
  assert.equal(await handleTaskProgressEvent(deps, event({ stage: 'done', status: 'succeeded' })), 'queued');
  assert.equal(session.delivered.length, 2);
  assert.deepEqual(
    session.delivered.map((s) => s.attributes!.stage),
    ['started', 'done'],
  );
});
