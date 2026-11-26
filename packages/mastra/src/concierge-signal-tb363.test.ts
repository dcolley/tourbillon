/**
 * TB-363 A2 — the stored needs-input line must tell the human HOW to answer (reply in this
 * thread resumes the task), and must still relay the stated ask verbatim (#340 contract).
 * The stored signal contents ARE the visible notice text (TB-363 R1 renders them directly),
 * so this is display-critical, not just model guidance.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskProgressSignalPayload, persistConciergeSignal, queueConciergeSignal } from './concierge-signal';

const base = {
  companyId: 'company-1',
  agentId: 'agent-1',
  chatTaskId: 'task-1',
  runId: 'run-1',
  status: 'succeeded' as const,
  title: 'Vendor call',
};

test('A2: waiting_on_user payload keeps the exact ask and says the human can reply here', () => {
  const payload = taskProgressSignalPayload({ ...base, stage: 'waiting_on_user', detail: 'Pick vendor A or B' });
  assert.match(payload.contents, /is waiting on the human: Pick vendor A or B/, 'full ask survives (never a generic "needs input")');
  assert.match(payload.contents, /reply here/, 'tells the human where to answer (M9: detail not dropped in the payload)');
  assert.match(payload.contents, /status pending/, 'states the resume contract (#340)');
});

test('A2: no detail -> no invented ask (still says reply here)', () => {
  const payload = taskProgressSignalPayload({ ...base, stage: 'waiting_on_user' });
  assert.match(payload.contents, /is waiting on the human\./);
  assert.match(payload.contents, /reply here/);
  assert.doesNotMatch(payload.contents, /Pick vendor/, 'nothing is invented');
});

test('MUST-4: persistConciergeSignal requests ifIdle.behavior=persist and resolves even when persisted never settles', async () => {
  // CONT3 root cause pinned: Mastra settles the idle-persist `persisted` handle only when
  // its broadcast stream is consumed — awaiting it hangs the bridge forever. The call must
  // resolve on `accepted` alone. (This test TIMES OUT if anyone re-adds an await.)
  const calls: Array<{ signal: { id?: string }; target: Record<string, unknown> }> = [];
  const neverSettled = new Promise<void>(() => {});
  const agent = {
    sendSignal(signal: { id?: string }, target: Record<string, unknown>) {
      calls.push({ signal, target });
      return { signal: { id: signal.id }, accepted: Promise.resolve({ action: 'persist' }), persisted: neverSettled };
    },
  };
  const payload = taskProgressSignalPayload({ ...base, stage: 'started', status: 'running' });
  const settled = await persistConciergeSignal(agent as never, { resourceId: 'r1', threadId: 't1' }, payload);
  assert.equal(calls.length, 1, 'exactly one Agent-level sendSignal');
  const t = calls[0]!.target as { resourceId?: string; threadId?: string; ifIdle?: { behavior?: string } };
  assert.equal(t.resourceId, 'r1');
  assert.equal(t.threadId, 't1');
  assert.equal(t.ifIdle?.behavior, 'persist', 'no-wake policy rides as ifIdle.behavior=persist (Session drops it — the Agent-level call is the only seam)');
  // MUST-6: ifActive MUST also be persist — Mastra's default 'deliver' queues the signal INTO
  // the in-flight same-agent run (mid-turn second reply) or returns 'blocked' cross-agent.
  assert.equal(
    (t as { ifActive?: { behavior?: string } }).ifActive?.behavior,
    'persist',
    'busy-origin no-wake policy rides as ifActive.behavior=persist (default deliver would drain mid-turn / block cross-agent)',
  );
  assert.equal(settled.action, 'persist');
});

// TB-363 MUST-7 (PM N-3): the covered go-between is a TRANSIENT wake — the session queue
// carries the flag so Mastra's persistence filters (filter-messages-for-persistence) skip
// storing it: the reply's content item renders from the run, no second notice row.
test('queueConciergeSignal passes transient:true through to Session.queueSignal (MUST-7)', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const session = {
    queueSignal: (signal: Record<string, unknown>) => {
      seen.push(signal);
      return Promise.resolve();
    },
  };
  const payload = taskProgressSignalPayload({
    companyId: 'c1',
    agentId: 'a1',
    chatTaskId: 't1',
    runId: 'r1',
    stage: 'waiting_on_user',
    status: 'succeeded',
    title: 'Deploy staging',
    detail: 'ask: prod or staging?',
  });
  await queueConciergeSignal(session as never, {
    tagName: payload.tagName,
    attributes: payload.attributes,
    contents: payload.contents,
    transient: true,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.transient, true, 'the go-between signal must be transient (no stored row)');
  assert.equal(seen[0]!.tagName, 'task-progress', 'delivered with the task-progress tag/shape');
  // A plain (non-transient) queue never sets the flag — normal wakes keep storing their row.
  await queueConciergeSignal(session as never, {
    tagName: payload.tagName,
    attributes: payload.attributes,
    contents: payload.contents,
  });
  assert.ok(!('transient' in seen[1]!) || seen[1]!.transient !== true, 'default wakes stay persistent');
});

// TB-363 MUST-6 (M21a killer): the persist call must carry BOTH policies. Mastra defaults
// ifActive to 'deliver' (agent-DtdQ6un6.js #sendSignal: activeBehavior = target.ifActive?.behavior
// ?? \"deliver\"), which queues the signal INTO a blocking run. NOTE (red-on-base evidence,
// RESULT): Mastra's active-run state is INSTANCE-LOCAL (state.activeThreadRunIds /
// threadRunsById, agent-DtdQ6un6.js:40154/40562), so a TN cell that holds the run on the
// chat-controller's Agent cannot observe the registry-side persist Agent ever being 'active'
// — this unit contract, not the TN cell, is what kills dropping the ifActive argument.
test('MUST-6: persistConciergeSignal sends ifIdle persist AND ifActive persist', async () => {
  const targets: Array<Record<string, unknown>> = [];
  const agent = {
    sendSignal: (_signal: unknown, target: Record<string, unknown>) => {
      targets.push(target);
      return { signal: { id: 'sig-c6' }, accepted: Promise.resolve({ action: 'persist' }) };
    },
  };
  const payload = taskProgressSignalPayload({ ...base, stage: 'waiting_on_user', detail: 'ask: prod or staging?' });
  const settled = await persistConciergeSignal(agent as never, { resourceId: 'res-9', threadId: 'th_9' }, payload);
  assert.equal(settled.action, 'persist');
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0]!.ifIdle, { behavior: 'persist' }, 'idle persists');
  assert.deepEqual(targets[0]!.ifActive, { behavior: 'persist' }, 'active persists too — never the deliver default');
  assert.equal(targets[0]!.threadId, 'th_9');
  assert.equal(targets[0]!.resourceId, 'res-9');
});

test('MUST-4: a rejected persisted handle never rejects the persist call (no unhandled crash)', async () => {
  const agent = {
    sendSignal(signal: { id?: string }, _target: Record<string, unknown>) {
      return {
        signal: { id: signal.id },
        accepted: Promise.resolve({ action: 'persist' }),
        persisted: Promise.reject(new Error('memory write failed')),
      };
    },
  };
  const payload = taskProgressSignalPayload({ ...base, stage: 'done', status: 'succeeded' });
  const settled = await persistConciergeSignal(agent as never, { resourceId: 'r1', threadId: 't1' }, payload);
  assert.equal(settled.action, 'persist');
});