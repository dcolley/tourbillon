/**
 * TN-* acceptance tests for task settle → Redis → task-progress bridge →
 * Session.queueSignal → PostgresStore.
 *
 * NOT RUN. Authoring only. Hermes/Spark1 runs this file later.
 * Do not add it to the closed-port web harness list.
 *
 * Oracle notes:
 * - Exactly-once is one persisted terminal notice and one terminal queueSignal
 *   for that event identity. Extra model calls inside that run are allowed.
 * - TN-ORIGIN-SWITCH* persist on source_thread_id (T1), including when the pin is T2.
 * - TN-ONCE-AFTER-NONDELIVERY records lost | recovered | double. It does not
 *   require an outbox. A first-attempt queueSignal means the drop was not armed
 *   and the harness throws instead of classifying.
 * - TN-TEARDOWN asserts the subscriber is gone after the only reset hook.
 *   There is no public unsubscribe today (GAP-TN-6); that assertion stays.
 * - waitForSessionRunIdle is not on this path (OUT_OF_PATH).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  assertBoundaryPrerequisites,
  closeBoundaryResources,
  readWithNewPostgresStore,
  runFalseRestart,
  runNotification,
  runTeardown,
  serial,
  startedNotices,
  terminalNotices,
  type NotificationEvidence,
  type NotificationSpec,
} from './task-notification-boundary-harness';

const TIMEOUT_MS = 120_000;

function spec(overrides: Partial<NotificationSpec> = {}): NotificationSpec {
  return {
    mode: 'done',
    busy: false,
    switchPin: false,
    busyDetached: false,
    republishTerminal: false,
    nondeliveryProbe: false,
    extraThread: false,
    extraAgent: false,
    extraCompany: false,
    ...overrides,
  };
}

function assertTerminal(evidence: NotificationEvidence): void {
  assert.equal(evidence.adapter, 'ephemeral-redis+postgres', evidence.diagnostic);
  assert.equal(evidence.schema, 'current-schema-bootstrap', evidence.diagnostic);
  assert.equal(evidence.userSendsAfterEvent, 0, evidence.diagnostic);
  assert.equal(evidence.listMyTasksExecutions, 0, evidence.diagnostic);
  assert.ok(evidence.publishedStages.includes(evidence.expectedStage), evidence.diagnostic);
  assert.equal(evidence.terminalQueueEntries, 1, evidence.diagnostic);
  assert.ok(evidence.terminalModelEntries >= 1, evidence.diagnostic);
  assert.equal(evidence.sourceThreadId, evidence.originThreadId, evidence.diagnostic);
  const onOrigin = terminalNotices(evidence);
  assert.equal(onOrigin.length, 1, evidence.diagnostic);
  const text = onOrigin[0]!.text;
  assert.match(
    text,
    new RegExp(`TN-NOTICE task=${evidence.taskId} run=${evidence.runId} stage=${evidence.expectedStage}`),
    evidence.diagnostic,
  );
  if (evidence.expectedStage === 'failed') {
    assert.match(text, /budget-exhausted-marker/, evidence.diagnostic);
    assert.doesNotMatch(text, /waiting on the human/, evidence.diagnostic);
    assert.equal(evidence.storedStatus, 'waiting_on_user', evidence.diagnostic);
    assert.match(evidence.storedNotes ?? '', /failure:/, evidence.diagnostic);
    assert.match(evidence.storedNotes ?? '', /budget-exhausted-marker/, evidence.diagnostic);
  } else if (evidence.expectedStage === 'waiting_on_user') {
    assert.match(text, /need-vendor-choice/, evidence.diagnostic);
    assert.equal(evidence.storedStatus, 'waiting_on_user', evidence.diagnostic);
    assert.match(evidence.storedNotes ?? '', /ask:/, evidence.diagnostic);
    assert.match(evidence.storedNotes ?? '', /need-vendor-choice/, evidence.diagnostic);
  } else {
    assert.equal(evidence.storedStatus, 'done', evidence.diagnostic);
    assert.doesNotMatch(text, /need-vendor-choice|budget-exhausted-marker/, evidence.diagnostic);
  }
}

function assertNoEarly(evidence: NotificationEvidence): void {
  assert.ok(evidence.earlyTerminalNotices, evidence.diagnostic);
  assert.equal(evidence.earlyTerminalNotices?.length ?? -1, 0, evidence.diagnostic);
  assert.equal(evidence.earlyTerminalModelEntries, 0, evidence.diagnostic);
}

function assertOriginNotPin(evidence: NotificationEvidence): void {
  assert.notEqual(evidence.pinThreadId, evidence.originThreadId, evidence.diagnostic);
  assert.equal(evidence.pinAtPublish, evidence.pinThreadId, evidence.diagnostic);
  assert.equal(terminalNotices(evidence, evidence.pinMessages).length, 0, evidence.diagnostic);
  assertTerminal(evidence);
}

describe('TN task-notification boundary', () => {
  before(async () => {
    await assertBoundaryPrerequisites();
  });

  after(() => {
    closeBoundaryResources();
  });

  it('TN-IDLE-DONE', { timeout: TIMEOUT_MS }, () => serial(async () => {
    const evidence = await runNotification(spec({ mode: 'done' }));
    assertTerminal(evidence);
    assert.equal(evidence.earlyTerminalNotices, null, evidence.diagnostic);
  }));

  it('TN-IDLE-FAIL', { timeout: TIMEOUT_MS }, () => serial(async () => {
    const evidence = await runNotification(spec({ mode: 'failure' }));
    assertTerminal(evidence);
  }));

  it('TN-IDLE-ASK', { timeout: TIMEOUT_MS }, () => serial(async () => {
    const evidence = await runNotification(spec({ mode: 'ask' }));
    assertTerminal(evidence);
  }));

  it('TN-BUSY-DONE', { timeout: TIMEOUT_MS }, () => serial(async () => {
    const evidence = await runNotification(spec({ mode: 'done', busy: true }));
    assertNoEarly(evidence);
    assertTerminal(evidence);
  }));

  it('TN-BUSY-FAIL', { timeout: TIMEOUT_MS }, () => serial(async () => {
    const evidence = await runNotification(spec({ mode: 'failure', busy: true }));
    assertNoEarly(evidence);
    assertTerminal(evidence);
  }));

  it('TN-BUSY-ASK', { timeout: TIMEOUT_MS }, () => serial(async () => {
    const evidence = await runNotification(spec({ mode: 'ask', busy: true }));
    assertNoEarly(evidence);
    assertTerminal(evidence);
  }));

  it('TN-ONCE-DUP', { timeout: TIMEOUT_MS }, () => serial(async () => {
    const evidence = await runNotification(spec({ mode: 'done', republishTerminal: true }));
    assert.ok(
      evidence.publishedStages.filter((stage) => stage === 'done').length >= 2,
      evidence.diagnostic,
    );
    assertTerminal(evidence);
  }));

  it('TN-ONCE-AFTER-NONDELIVERY', { timeout: TIMEOUT_MS }, () => serial(async () => {
    const evidence = await runNotification(spec({ mode: 'done', nondeliveryProbe: true, busyDetached: true }));
    assert.ok(evidence.probe, evidence.diagnostic);
    assert.equal(evidence.probe?.firstAttemptReachedQueueSignal, false, evidence.diagnostic);
    assert.ok((evidence.probe?.redisTerminalCopies ?? 0) >= 2, evidence.diagnostic);
    assert.ok(
      evidence.probe?.classification === 'lost' ||
        evidence.probe?.classification === 'recovered' ||
        evidence.probe?.classification === 'double',
      evidence.diagnostic,
    );
    console.log(`TN-ONCE-AFTER-NONDELIVERY-OBSERVATION: ${JSON.stringify(evidence.probe)}`);
  }));

  it('TN-ISO-THREAD', { timeout: TIMEOUT_MS }, () => serial(async () => {
    const evidence = await runNotification(spec({ mode: 'done', extraThread: true }));
    assertTerminal(evidence);
    assert.equal(terminalNotices(evidence, evidence.extraThreadMessages).length, 0, evidence.diagnostic);
  }));

  it('TN-ISO-AGENT', { timeout: TIMEOUT_MS }, () => serial(async () => {
    const evidence = await runNotification(spec({ mode: 'done', extraAgent: true }));
    assertTerminal(evidence);
    assert.equal(
      evidence.otherAgentMessages.filter((message) => message.text.includes(evidence.taskId)).length,
      0,
      evidence.diagnostic,
    );
  }));

  it('TN-ISO-COMPANY', { timeout: TIMEOUT_MS }, () => serial(async () => {
    const evidence = await runNotification(spec({ mode: 'done', extraCompany: true }));
    assertTerminal(evidence);
    assert.equal(
      evidence.otherCompanyMessages.filter((message) => message.text.includes(evidence.taskId)).length,
      0,
      evidence.diagnostic,
    );
  }));

  it('TN-ORIGIN-SWITCH-IDLE', { timeout: TIMEOUT_MS }, () => serial(async () => {
    const evidence = await runNotification(spec({ mode: 'done', switchPin: true }));
    assertOriginNotPin(evidence);
  }));

  it('TN-ORIGIN-SWITCH-BUSY', { timeout: TIMEOUT_MS }, () => serial(async () => {
    const evidence = await runNotification(spec({ mode: 'done', switchPin: true, busy: true }));
    assertNoEarly(evidence);
    assertOriginNotPin(evidence);
  }));

  it('TN-NO-FALSE-RUN', { timeout: TIMEOUT_MS }, () => serial(async () => {
    const evidence = await runFalseRestart();
    assert.match(evidence.message, /RE-QUEUED/);
    assert.match(evidence.message, /NOT running/);
    assert.doesNotMatch(evidence.message, /running again/i);
    assert.equal(evidence.status, 'pending');
    assert.deepEqual(evidence.publishedStages, []);
  }));

  it('TN-ORDER-DISTINCT', { timeout: TIMEOUT_MS }, () => serial(async () => {
    const evidence = await runNotification(spec({ mode: 'done' }));
    assertTerminal(evidence);
    const started = startedNotices(evidence);
    const terminal = terminalNotices(evidence);
    if (started.length > 0) {
      const startedAt = started[0]!.createdAtMs;
      const terminalAt = terminal[0]!.createdAtMs;
      assert.ok(startedAt !== null && terminalAt !== null, `${evidence.diagnostic} missing createdAt for order`);
      assert.ok(startedAt <= terminalAt, evidence.diagnostic);
    }
  }));

  it('TN-TEARDOWN', { timeout: TIMEOUT_MS }, () => serial(async () => {
    const evidence = await runTeardown();
    assert.equal(evidence.stopExport, false);
    assert.equal(
      evidence.patternsAfterReset,
      evidence.baselinePatterns,
      `orphaned redis psubscribe after __resetTaskProgressSignalBridgeForTests ` +
        `(baseline ${evidence.baselinePatterns}, after ${evidence.patternsAfterReset}). ` +
        'GAP-TN-6: no public unsubscribe. This assertion is intentionally not weakened.',
    );
  }));

  it('TN-NO-POLL', { timeout: TIMEOUT_MS }, () => serial(async () => {
    const evidence = await runNotification(spec({ mode: 'done' }));
    assert.equal(evidence.listMyTasksExecutions, 0, evidence.diagnostic);
    assert.equal(evidence.userSendsAfterEvent, 0, evidence.diagnostic);
    assertTerminal(evidence);
  }));

  it('TN-PERSIST-FRESH', { timeout: TIMEOUT_MS }, () => serial(async () => {
    const evidence = await runNotification(spec({ mode: 'done' }));
    assertTerminal(evidence);
    const fresh = await readWithNewPostgresStore(evidence.originThreadId);
    assert.equal(terminalNotices(evidence, fresh).length, 1, evidence.diagnostic);
    assert.match(fresh.map((message) => message.text).join('\n'), new RegExp(`run=${evidence.runId}`));
  }));
});
