/**
 * TB-363 A2 — the stored needs-input line must tell the human HOW to answer (reply in this
 * thread resumes the task), and must still relay the stated ask verbatim (#340 contract).
 * The stored signal contents ARE the visible notice text (TB-363 R1 renders them directly),
 * so this is display-critical, not just model guidance.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskProgressSignalPayload, persistConciergeSignal } from './concierge-signal';

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
  assert.equal(settled.action, 'persist');
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
