/**
 * CONCIERGE-QUEUE-SIGNAL unit tests: the helper writes typed `reactive` signals (never user
 * messages), preserves attributes, clamps contents, cancels by id, and maps every Run Task
 * transition to the right human line. The queue ordering itself (idle wakes / active waits)
 * belongs to Mastra's shared queue — the fake session below emulates its documented contract
 * so we pin that OUR code always goes through queueSignal and never interrupts a live run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cancelQueuedConciergeSignals,
  queueConciergeSignal,
  sanitizeSignalAttributes,
  taskProgressSignalPayload,
  TASK_PROGRESS_TAG_NAME,
  type QueueSignalSession,
} from './concierge-signal';

interface QueuedSignal {
  type: string;
  tagName?: string;
  attributes?: Record<string, unknown>;
  contents: string;
  id?: string;
}

/**
 * Fake of Mastra's queue contract: idle → the signal starts a run immediately; active → the
 * signal waits on the shared queue and a NEW run picks it up after the current one ends.
 * Any attempt to send mid-run (sendMessage/steer/sendSignal) is recorded as a violation.
 */
class FakeSession implements QueueSignalSession {
  busy = false;
  queued: QueuedSignal[] = [];
  delivered: QueuedSignal[] = [];
  violations: string[] = [];
  queueCalls = 0;

  queueSignal(signal: QueuedSignal): Promise<void> {
    this.queueCalls += 1;
    if (this.busy) this.queued.push(signal);
    else this.delivered.push(signal);
    return Promise.resolve();
  }

  /** A live run must never be interrupted for routine progress (product lock). */
  sendMessage(): void {
    this.violations.push('sendMessage');
  }
  steer(): void {
    this.violations.push('steer');
  }
  sendSignal(): void {
    this.violations.push('sendSignal');
  }

  startRun(): void {
    this.busy = true;
  }
  finishRun(): QueuedSignal[] {
    this.busy = false;
    // Next run starts with everything queued while it was active.
    const drained = this.queued.splice(0, this.queued.length);
    this.delivered.push(...drained);
    return drained;
  }
}

test('idle session: queueConciergeSignal wakes the thread immediately as a typed reactive signal', async () => {
  const session = new FakeSession();
  const { signalId } = await queueConciergeSignal(session, {
    tagName: TASK_PROGRESS_TAG_NAME,
    attributes: { taskId: 'task-1', status: 'running' },
    contents: 'Background task started: "Ship the runbook".',
  });
  assert.equal(session.queueCalls, 1);
  assert.equal(session.delivered.length, 1);
  assert.equal(session.queued.length, 0);
  const signal = session.delivered[0]!;
  assert.equal(signal.type, 'reactive');
  assert.equal(signal.tagName, 'task-progress');
  assert.deepEqual(signal.attributes, { taskId: 'task-1', status: 'running' });
  assert.match(signal.contents, /Background task started/);
  assert.ok(signalId.length > 0);
  assert.equal(signal.id, signalId);
  assert.deepEqual(session.violations, []);
});

test('active session: the signal waits for the current run, then the next run gets it', async () => {
  const session = new FakeSession();
  session.startRun();
  await queueConciergeSignal(session, { contents: 'Background task done: "Ship the runbook".' });
  // While the run is active: queued, NOT delivered, and no mid-token interrupt was attempted.
  assert.equal(session.delivered.length, 0);
  assert.equal(session.queued.length, 1);
  assert.deepEqual(session.violations, []);

  const drained = session.finishRun();
  assert.equal(drained.length, 1);
  assert.equal(drained[0]!.tagName, 'task-progress');
  assert.equal(session.delivered.length, 1);
});

test('multiple signals while active keep FIFO order in the shared queue', async () => {
  const session = new FakeSession();
  session.startRun();
  await queueConciergeSignal(session, { contents: 'first' });
  await queueConciergeSignal(session, { contents: 'second' });
  await queueConciergeSignal(session, { contents: 'third' });
  const drained = session.finishRun();
  assert.deepEqual(
    drained.map((s) => s.contents),
    ['first', 'second', 'third'],
  );
});

test('attributes: printable values preserved, objects dropped, long strings clamped', async () => {
  const session = new FakeSession();
  const long = 'x'.repeat(300);
  await queueConciergeSignal(session, {
    attributes: {
      taskId: 'task-9',
      attempts: 2,
      paused: false,
      nested: { nope: true },
      list: [1, 2],
      missing: null,
      long,
    } as Record<string, unknown>,
    contents: 'ok',
  });
  const attrs = session.delivered[0]!.attributes!;
  assert.equal(attrs.taskId, 'task-9');
  assert.equal(attrs.attempts, 2);
  assert.equal(attrs.paused, false);
  assert.equal('nested' in attrs, false);
  assert.equal('list' in attrs, false);
  assert.equal('missing' in attrs, false);
  assert.ok((attrs.long as string).length <= 120);
  assert.ok((attrs.long as string).endsWith('…'));
});

test('contents: trimmed and clamped (attributes stay small, model reads the line)', async () => {
  const session = new FakeSession();
  await queueConciergeSignal(session, { contents: `  ${'y'.repeat(900)}  ` });
  const contents = session.delivered[0]!.contents;
  assert.ok(contents.length <= 500);
  assert.ok(contents.endsWith('…'));
});

test('default tagName is task-progress and type is always reactive', async () => {
  const session = new FakeSession();
  await queueConciergeSignal(session, { contents: 'hello' });
  assert.equal(session.delivered[0]!.tagName, 'task-progress');
  assert.equal(session.delivered[0]!.type, 'reactive');
});

test('cancel: queued signals are cancelled by id; empty ids / unsupported agent are no-ops', async () => {
  const cancelled: Array<{ threadId: string; signalIds: string[]; resourceId?: string }> = [];
  const agent = {
    cancelQueuedMessages(target: { threadId: string; signalIds: string[]; resourceId?: string }) {
      cancelled.push(target);
      return { cancelledSignalIds: [...target.signalIds] };
    },
  };
  const ids = await cancelQueuedConciergeSignals(agent, {
    resourceId: 'company-1:chat:free',
    threadId: 'thread-1',
    signalIds: ['sig-a', 'sig-b'],
  });
  assert.deepEqual(ids, ['sig-a', 'sig-b']);
  assert.deepEqual(cancelled[0]!.signalIds, ['sig-a', 'sig-b']);
  assert.equal(cancelled[0]!.resourceId, 'company-1:chat:free');

  assert.deepEqual(await cancelQueuedConciergeSignals(agent, { threadId: 't', signalIds: [] }), []);
  assert.deepEqual(cancelled.length, 1); // empty ids made no call
  assert.deepEqual(await cancelQueuedConciergeSignals({}, { threadId: 't', signalIds: ['x'] }), []);
});

test('sanitizeSignalAttributes keeps only printable scalars', () => {
  const out = sanitizeSignalAttributes({ a: 'x', b: 1, c: true, d: {}, e: undefined, f: [1] });
  assert.deepEqual(out, { a: 'x', b: 1, c: true });
});

// ─── TASK-RUNNER status → signal contents (the product lines) ───────────────

function progress(over: Partial<Parameters<typeof taskProgressSignalPayload>[0]> = {}) {
  return {
    companyId: 'company-1',
    agentId: 'agent-1',
    chatTaskId: 'task-1',
    runId: 'run-1',
    stage: 'started' as const,
    status: 'running' as const,
    title: 'Ship the runbook',
    ...over,
  };
}

test('progress: started → one short line naming the task', () => {
  const payload = taskProgressSignalPayload(progress());
  assert.equal(payload.tagName, 'task-progress');
  assert.match(payload.contents, /^Background task started: "Ship the runbook"\./);
  assert.deepEqual(payload.attributes, {
    taskId: 'task-1',
    runId: 'run-1',
    stage: 'started',
    status: 'running',
  });
});

test('progress: done → completion line', () => {
  const payload = taskProgressSignalPayload(progress({ stage: 'done', status: 'succeeded' }));
  assert.equal(payload.contents, 'Background task done: "Ship the runbook".');
});

test('progress: needs_review + failed → needs another look', () => {
  const payload = taskProgressSignalPayload(progress({ stage: 'needs_review', status: 'failed' }));
  assert.match(payload.contents, /needs another look/);
  assert.doesNotMatch(payload.contents, /decision/);
});

test('progress: needs_review + skipped → needs a decision', () => {
  const payload = taskProgressSignalPayload(progress({ stage: 'needs_review', status: 'skipped' }));
  assert.match(payload.contents, /needs a decision/);
});

test('progress: the full queue path — every transition lands as one typed signal each', async () => {
  const session = new FakeSession();
  const events = [
    progress(),
    progress({ stage: 'needs_review', status: 'failed' }),
    progress({ stage: 'started' }),
    progress({ stage: 'done', status: 'succeeded' }),
  ];
  for (const event of events) {
    const payload = taskProgressSignalPayload(event);
    await queueConciergeSignal(session, payload);
  }
  assert.equal(session.delivered.length, 4);
  assert.deepEqual(
    session.delivered.map((s) => s.attributes!.status),
    ['running', 'failed', 'running', 'succeeded'],
  );
  assert.deepEqual(session.violations, []);
});
