/**
 * TB-363 A2 — the stored needs-input line must tell the human HOW to answer (reply in this
 * thread resumes the task), and must still relay the stated ask verbatim (#340 contract).
 * The stored signal contents ARE the visible notice text (TB-363 R1 renders them directly),
 * so this is display-critical, not just model guidance.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskProgressSignalPayload } from './concierge-signal';

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
