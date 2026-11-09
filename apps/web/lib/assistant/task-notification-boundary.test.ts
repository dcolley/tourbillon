/**
 * TN boundary certification — real-service B cells (v2.1 §14–§15).
 *
 * Production chain: default task-runner emitProgress (createTaskProgressPublisher)
 * → Redis sse:{companyId} → startTaskProgressSignalBridge defaults (realDeliver)
 * → real registry controller/session → Session.queueSignal → PostgresStore
 * → independently constructed PostgresStore reader.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import {
  TASK_PROGRESS_DRAIN_TIMEOUT_MS,
  assertBoundaryPrerequisites,
  bridgeCurrentHandle,
  bridgeLog,
  bridgeReset,
  bridgeStart,
  bridgeStop,
  buildFixture,
  capability,
  countNotices,
  HELD_MARKER,
  isFixedCapable,
  loadPublisher,
  invokeDefaultPoller,
  progressEvent,
  publishProgress,
  deliveryAccount,
  assertC1ModelOnlyOverride,
  recordVerdict,
  persistVerdicts,
  startRedisObserver,
  redisTerminalEvents,
  claimOutcomeLog,
  redisTerminalLog,
  runHeldUser,
  tnFreshText,
  tnFreshMessages,
  countNoticeMessages,
  tnSetQueueHold,
  tnQueueHoldActive,
  sessionIdentityOf,
  assertThreadsUsable,
  tnSignalRecords,
  tnTeardown,
  waitFor,
  tnTrace,
  withAckGate,
} from './task-notification-boundary-harness';
import { startTaskProgressSignalBridge, __resetTaskProgressSignalBridgeForTests, redisClaimClient } from './task-progress-bridge';

const INCOMPAT = 'MISSING_EVIDENCE/HARNESS_INCOMPATIBLE';

after(async () => {
  await tnTeardown();
});


async function skipIfIncompatible(t: { name: string }, name: string): Promise<boolean> {
  if (isFixedCapable()) return false;
  recordVerdict(name, INCOMPAT, capability.reason.join('; '));
  t; // keep signature
  return true;
}

async function assertC4Pin(f: { readPin: () => Promise<string | null>; pinBefore: string | null }, expected?: string | null) {
  const want = expected !== undefined ? expected : f.pinBefore;
  assert.equal(await f.readPin(), want, want === f.pinBefore ? 'C4 pin unchanged' : 'C4 pin after delivery');
}

test('TN-PROVENANCE-PREFLIGHT', { timeout: 30_000 }, async () => {
  await assertBoundaryPrerequisites();
  recordVerdict(
    'TN-PROVENANCE-PREFLIGHT',
    isFixedCapable() ? 'GREEN' : INCOMPAT,
    capability.reason.join('; ') || 'all protocol capabilities present',
  );
});

test('TN-DEFAULT-PATH', { timeout: 90_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-DEFAULT-PATH')) return;
  await loadPublisher();
  await startRedisObserver();
  await bridgeReset();
  await bridgeStart();
  const f = await buildFixture({ seedPin: 't2' });
  try {
    await assertThreadsUsable([f.t2, f.t3, f.t9]);
    const { registerChatModelOverride } = await import('@tourbillon/mastra/chat');
    await assertC1ModelOnlyOverride(
      f.controllerA,
      f.recordA as { id: string; companyId: string },
      () => {
        registerChatModelOverride({ companyId: f.companyId, agentId: f.agentId }, { resolveModel: () => f.models.a.mock as never });
      },
      { threadId: f.t2 },
    );
    assert.equal(tnQueueHoldActive(), false, 'DEFAULT-PATH is pristine model-only: no TN-DRAIN-TIMEOUT queueSignal hold');
    const chat = await import('@/lib/chat');
    const { chatSessionId } = await import('@/lib/chat/session-id');
    const resourceA = chat.chatResourceId(f.companyId);
    const resourceB = chat.chatResourceId(f.companyIdB);
    assert.notEqual(resourceA, resourceB, 'distinct resource identities');
    assert.notEqual(f.controllerA.id, f.controllerB.id, 'distinct controller identities');
    assert.notEqual(
      chat.chatControllerId(f.agentId),
      chat.chatControllerId(f.agentIdB),
      'distinct controller cache keys',
    );
    const sessionA = sessionIdentityOf(f.userSession);
    const rawSessionB = await chat.getChatSession(f.controllerB as never, f.recordB as never, { threadId: f.t1b });
    const sessionB = sessionIdentityOf(rawSessionB);
    assert.notEqual(sessionA.sessionId, sessionB.sessionId, 'distinct session identities (ids, not thread ids)');
    assert.notEqual(sessionA.resourceId, sessionB.resourceId, 'distinct session resource ids');
    assert.equal(sessionA.sessionId, chatSessionId(resourceA), 'A session id follows production formula');
    assert.equal(sessionB.sessionId, chatSessionId(resourceB), 'B session id follows production formula');
    const poll = await invokeDefaultPoller(progressEvent(f));
    assert.ok((poll.started ?? 0) >= 1, 'default poller claimed and started a run');
    await waitFor('T1 notice', async () => countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done') >= 1);
    await waitFor('poller Redis copies', async () => redisTerminalEvents(f.taskId).length >= 2);
    const acct = deliveryAccount(f.taskId, f.models.a);
    const stages = acct.redisCopies.map((row) => {
      const p = row.payload as { stage?: string };
      return typeof p === 'object' && p && p.stage ? p.stage : JSON.stringify(row.payload);
    });
    assert.ok(stages.includes('started'), `Redis observer saw started: ${stages.join(',')}`);
    assert.ok(stages.includes('done'), `Redis observer saw done: ${stages.join(',')}`);
    assert.equal(acct.redisCopies.length, 2, 'exact Redis copies (started+done) from default poller');
    assert.ok(acct.claims.some((c) => c.outcome === true && String(c.detail ?? '').startsWith('poller:')), 'poller claim won');
    assert.ok(acct.claims.some((c) => c.outcome === true && !String(c.detail ?? '').startsWith('poller:')), 'bridge claim won');
    assert.ok(acct.queues.length >= 1, 'queueSignal entries recorded');
    assert.equal(acct.modelUser, 0, 'DEFAULT-PATH: no user-identity run');
    const t1 = await tnFreshMessages(f.t1);
    const t2 = await tnFreshMessages(f.t2);
    assert.equal(countNoticeMessages(t1, f.taskId, 'done'), 1);
    assert.equal(countNoticeMessages(t2, f.taskId), 0);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t9), f.taskId), 0, 'nothing on usable T9');
    assert.equal(f.controllerA.id !== f.controllerB.id, true, 'distinct real controller identities');
    assert.equal(tnQueueHoldActive(), false, 'DEFAULT-PATH still has no drain-timeout queue hold after delivery');
    await assertC4Pin(f);
    recordVerdict('TN-DEFAULT-PATH', 'GREEN');
  } finally {
    await f.cleanup();
  }
});

async function idleCell(name: string, stage: string, status: string) {
  await bridgeReset();
  await bridgeStart();
  const f = await buildFixture({ seedPin: 't2' });
  try {
    await assertThreadsUsable([f.t2, f.t3, f.t9]);
    await publishProgress(progressEvent(f, {
      stage,
      status,
      ...(stage === 'waiting_on_user' ? { detail: 'ask: confirm the vendor' } : {}),
    }));
    await waitFor(`${name} T1`, async () => countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, stage) >= 1);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, stage), 1, 'exactly one terminal notice on T1');
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t2), f.taskId), 0, 'nothing on pin T2');
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t9), f.taskId), 0, 'nothing on usable T9');
    await assertC4Pin(f);
    assert.equal(f.userSession.thread.getId(), f.t2, 'user session stayed on T2');
    const sigs = tnSignalRecords({ taskId: f.taskId, tagName: 'task-progress' });
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0]!.threadId, f.t1);
    recordVerdict(name, 'GREEN');
    return f;
  } catch (err) {
    recordVerdict(name, 'RED', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await f.cleanup();
  }
}

test('TN-IDLE-DONE', { timeout: 90_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-IDLE-DONE')) return;
  await idleCell('TN-IDLE-DONE', 'done', 'succeeded');
});

test('TN-IDLE-FAIL', { timeout: 90_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-IDLE-FAIL')) return;
  await idleCell('TN-IDLE-FAIL', 'failed', 'failed');
});

test('TN-IDLE-ASK', { timeout: 90_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-IDLE-ASK')) return;
  await idleCell('TN-IDLE-ASK', 'waiting_on_user', 'succeeded');
});

test('TN-NO-FALSE-RUN', { timeout: 90_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-NO-FALSE-RUN')) return;
  await bridgeReset();
  await bridgeStart();
  const f = await buildFixture({ seedPin: 't2' });
  try {
    await assertThreadsUsable([f.t2, f.t3, f.t9]);
    const event = progressEvent(f, { stage: 'done', status: 'succeeded' });
    await publishProgress(event);
    await waitFor('TN-NO-FALSE-RUN T1', async () => countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done') >= 1);
    const acct = deliveryAccount(f.taskId, f.models.a);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done'), 1, 'exactly one terminal notice');
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t2), f.taskId), 0, 'nothing on pin T2');
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t9), f.taskId), 0, 'nothing on usable T9');
    assert.equal(tnSignalRecords({ taskId: f.taskId, tagName: 'task-progress' }).length, 1, 'exactly one queueSignal');
    assert.equal(acct.modelUser, 0, 'no extra user/notification run');
    await assertC4Pin(f);
    recordVerdict('TN-NO-FALSE-RUN', 'GREEN');
  } catch (err) {
    recordVerdict('TN-NO-FALSE-RUN', 'RED', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await f.cleanup();
  }
});

test('TN-BUSY-UNRELATED-PIN', { timeout: 120_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-BUSY-UNRELATED-PIN')) return;
  await bridgeReset();
  await bridgeStart();
  const f = await buildFixture({ seedPin: 't2', holdUser: true });
  let held: Promise<unknown> | undefined;
  try {
    held = (await runHeldUser(f)).pending;
    tnTrace("unrelated:runHeldUser-returned");
    const runId = f.userSession.getCurrentRunId();
    tnTrace("unrelated:got-runId", { runId });
    tnTrace('unrelated:after-hold', { runId, userThread: f.userSession.thread.getId(), pin: f.pinBefore });
    assert.ok(runId, 'B-HOLD: T2 run id non-null');
    await assertThreadsUsable([f.t2, f.t3, f.t9]);
    tnTrace('unrelated:before-publish');
    await publishProgress(progressEvent(f));
    tnTrace('unrelated:after-publish', { signals: tnSignalRecords({ taskId: f.taskId }).length, calls: f.models.a.callLog.length });
    await waitFor('T1 while T2 held', async () => countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done') >= 1, 25_000);
    tnTrace('unrelated:after-T1-wait', { runIdNow: f.userSession.getCurrentRunId() });
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done'), 1);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t2), f.taskId), 0);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t9), f.taskId), 0, 'nothing on usable T9');
    assert.equal(f.userSession.getCurrentRunId(), runId, 'held T2 run not cancelled/rebound');
    assert.equal(f.userSession.thread.getId(), f.t2);
    await assertC4Pin(f);
    tnTrace('unrelated:before-release');
    f.models.a.releaseChunks();
    tnTrace('unrelated:after-release, awaiting held send');
    await held;
    tnTrace('unrelated:held-send-settled');
    const t2msgs = await tnFreshMessages(f.t2);
    assert.ok(t2msgs.some((m) => m.includes(HELD_MARKER)), 'T2 own output persisted after release');
    assert.equal(countNoticeMessages(t2msgs, f.taskId), 0);
    recordVerdict('TN-BUSY-UNRELATED-PIN', 'GREEN');
  } catch (err) {
    f.models.a.releaseChunks();
    recordVerdict('TN-BUSY-UNRELATED-PIN', 'RED', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    f.models.a.releaseChunks();
    await held?.catch(() => {});
    await f.cleanup();
  }
});

test('TN-BUSY-ORIGIN-HELD', { timeout: 120_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-BUSY-ORIGIN-HELD')) return;
  await bridgeReset();
  await bridgeStart();
  const f = await buildFixture({ seedPin: 't2', holdUser: true });
  let held: Promise<unknown> | undefined;
  try {
    f.userSession.thread.switch({ threadId: f.t1 });
    held = f.userSession.sendMessage({ content: 'TN-HOLD-USER origin busy' });
    await waitFor('origin hold entered', async () => f.models.a.callLog.some((c) => c.identity === 'user'), 15_000);
    await waitFor('origin run id', async () => !!f.userSession.getCurrentRunId(), 15_000);
    const early = await tnFreshMessages(f.t1);
    assert.equal(countNoticeMessages(early, f.taskId), 0, 'B-NO-EARLY before publish');
    await assertThreadsUsable([f.t2, f.t3, f.t9]);
    await publishProgress(progressEvent(f));
    await waitFor('queue entered while origin held', async () => tnSignalRecords({ taskId: f.taskId }).length >= 1, 15_000);
    assert.ok(redisTerminalEvents(f.taskId).length >= 1, 'Redis terminal observed during hold');
    assert.equal(f.models.a.callLog.filter((c) => c.notice).length, 0, 'zero terminal-model-entry during hold');
    const heldAcct = deliveryAccount(f.taskId, f.models.a);
    assert.ok(heldAcct.claims.some((c) => c.outcome === true), 'claim recorded during hold');
    assert.equal(heldAcct.queues.length, 1, 'exactly one queueSignal while origin held');
    assert.equal(heldAcct.modelNotice, 0, 'zero terminal-model-entry during hold (accounted)');
    const mid = await tnFreshMessages(f.t1);
    assert.equal(countNoticeMessages(mid, f.taskId), 0, 'B-NO-EARLY: no persist while origin held');
    f.models.a.releaseChunks();
    await held;
    await waitFor('T1 after origin release', async () => countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done') >= 1);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done'), 1);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t2), f.taskId), 0);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t9), f.taskId), 0, 'nothing on usable T9');
    const after = deliveryAccount(f.taskId, f.models.a);
    assert.equal(after.queues.length, 1, 'no extra queueSignal after release');
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done'), 1);
    await assertC4Pin(f);
    recordVerdict('TN-BUSY-ORIGIN-HELD', 'GREEN');
  } catch (err) {
    f.models.a.releaseChunks();
    recordVerdict('TN-BUSY-ORIGIN-HELD', 'RED', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    f.models.a.releaseChunks();
    await held?.catch(() => {});
    await f.cleanup();
  }
});

test('TN-CONCURRENT-THREAD-SWITCH', { timeout: 90_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-CONCURRENT-THREAD-SWITCH')) return;
  await bridgeReset();
  await bridgeStart();
  const f = await buildFixture({ seedPin: 't2' });
  try {
    assert.equal(f.pinBefore, f.t2, 'pin started on T2');
    await assertThreadsUsable([f.t2, f.t3, f.t9]);
    const pub = publishProgress(progressEvent(f));
    await waitFor('delivery interval before switch', async () => redisTerminalEvents(f.taskId).length >= 1);
    assert.ok(redisTerminalEvents(f.taskId).length >= 1, 'Redis observer established the delivery interval (no sleep)');
    f.userSession.thread.switch({ threadId: f.t3 });
    await f.pool.query(
      `insert into assistant_active_threads (company_id, agent_id, thread_id, updated_at)
       values ($1,$2,$3, now())
       on conflict (company_id, agent_id) do update set thread_id = excluded.thread_id, updated_at = now()`,
      [f.companyId, f.agentId, f.t3],
    );
    await pub;
    await waitFor('T1 after user switch', async () => countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done') >= 1);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done'), 1);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t2), f.taskId), 0);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t3), f.taskId), 0);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t9), f.taskId), 0, 'nothing on usable T9');
    assert.equal(f.userSession.thread.getId(), f.t3, 'newest user choice T3 remains');
    await assertC4Pin(f, f.t3);
    recordVerdict('TN-CONCURRENT-THREAD-SWITCH', 'GREEN');
  } catch (err) {
    recordVerdict('TN-CONCURRENT-THREAD-SWITCH', 'RED', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await f.cleanup();
  }
});

test('TN-CONCURRENT-ORIGIN-NOTICES', { timeout: 90_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-CONCURRENT-ORIGIN-NOTICES')) return;
  await bridgeReset();
  await bridgeStart();
  const f = await buildFixture({ seedPin: 't2', secondOriginNotice: true });
  try {
    assert.notEqual(f.t1, f.tOrigin2, 'second origin is a distinct thread, not T1');
    assert.notEqual(f.taskId, f.taskId2, 'second task is distinct');
    await assertThreadsUsable([f.t1, f.tOrigin2, f.t2, f.t3, f.t9]);
    await Promise.all([
      publishProgress(progressEvent(f, { runId: 'run-a' })),
      publishProgress(progressEvent({ ...f, taskId: f.taskId2 }, { runId: 'run-b' })),
    ]);
    await waitFor('both origin notices', async () => {
      return (
        countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done') >= 1 &&
        countNoticeMessages(await tnFreshMessages(f.tOrigin2), f.taskId2, 'done') >= 1
      );
    });
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done'), 1);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.tOrigin2), f.taskId2, 'done'), 1, 'second origin is a distinct thread');
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t1), f.taskId2), 0);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.tOrigin2), f.taskId), 0);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t2), f.taskId), 0);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t2), f.taskId2), 0);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t3), f.taskId), 0);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t3), f.taskId2), 0);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t9), f.taskId), 0, 'nothing on usable T9 for task 1');
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t9), f.taskId2), 0, 'nothing on usable T9 for task 2');
    await assertC4Pin(f);
    recordVerdict('TN-CONCURRENT-ORIGIN-NOTICES', 'GREEN');
  } catch (err) {
    recordVerdict('TN-CONCURRENT-ORIGIN-NOTICES', 'RED', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await f.cleanup();
  }
});

test('TN-CONCURRENT-AGENT-COMPANY', { timeout: 90_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-CONCURRENT-AGENT-COMPANY')) return;
  await bridgeReset();
  await bridgeStart();
  const f = await buildFixture({ seedPin: 't2', secondCompany: true });
  try {
    assert.notEqual(f.controllerA.id, f.controllerB.id, 'C-SHARED-IDENTITY: distinct controller ids');
    await assertThreadsUsable([f.t1, f.t1b, f.t2, f.t9]);
    const chatIds = await import('@/lib/chat');
    assert.notEqual(chatIds.chatControllerId(f.agentId), chatIds.chatControllerId(f.agentIdB), 'distinct controller cache keys');
    const sessA = sessionIdentityOf(f.userSession);
    const sessB = sessionIdentityOf(await chatIds.getChatSession(f.controllerB as never, f.recordB as never, { threadId: f.t1b }));
    assert.notEqual(sessA.resourceId, sessB.resourceId, 'distinct session resource ids (cross-company)');
    assert.notEqual(sessA.sessionId, sessB.sessionId, 'distinct session ids (cross-company)');
    await Promise.all([
      publishProgress(progressEvent(f, { runId: 'run-a' })),
      publishProgress(
        progressEvent(
          { companyId: f.companyIdB, agentId: f.agentIdB, taskId: f.taskIdB },
          { runId: 'run-b' },
        ),
      ),
    ]);
    await waitFor('A notice', async () => countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done') >= 1);
    await waitFor('B notice', async () => countNoticeMessages(await tnFreshMessages(f.t1b), f.taskIdB, 'done') >= 1);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done'), 1, 'exact one notice for A');
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t1b), f.taskIdB, 'done'), 1, 'exact one notice for B');
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t1), f.taskIdB), 0, 'no cross-company leak onto A');
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t1b), f.taskId), 0, 'no cross-company leak onto B');
    assert.notEqual(f.controllerA.id, f.controllerB.id);
    await assertC4Pin(f);
    recordVerdict('TN-CONCURRENT-AGENT-COMPANY', 'GREEN');
  } catch (err) {
    recordVerdict('TN-CONCURRENT-AGENT-COMPANY', 'RED', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await f.cleanup();
  }
});

test('TN-ONCE-DUP', { timeout: 90_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-ONCE-DUP')) return;
  await bridgeReset();
  await bridgeStart();
  const f = await buildFixture({ seedPin: 't2' });
  try {
    await assertThreadsUsable([f.t2, f.t3, f.t9]);
    const event = progressEvent(f, { runId: 'run-dup' });
    await publishProgress(event);
    await waitFor('first notice', async () => countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done') >= 1);
    await waitFor('first Redis copy', async () => redisTerminalEvents(f.taskId).length >= 1);
    const first = deliveryAccount(f.taskId, f.models.a);
    assert.equal(first.redisCopies.length, 1, 'exact first Redis copy');
    const noticeCallsAfterFirst = first.modelNotice;
    await publishProgress(event);
    await waitFor('second Redis copy', async () => redisTerminalEvents(f.taskId).length >= 2);
    await waitFor('duplicate claim lost', async () =>
      claimOutcomeLog.some((c) => (JSON.stringify(c).includes(f.taskId) || JSON.stringify(c).includes('run-dup')) && c.outcome === false),
    );
    const acct = deliveryAccount(f.taskId, f.models.a);
    const claims = acct.claims.filter((c) => JSON.stringify(c).includes(f.taskId) || JSON.stringify(c).includes('run-dup'));
    assert.equal(acct.redisCopies.length, 2, 'exact two Redis copies (first + duplicate publish)');
    assert.ok(claims.some((c) => c.outcome === true), 'first claim won');
    assert.ok(claims.some((c) => c.outcome === false), 'second claim lost (duplicate)');
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done'), 1);
    assert.equal(tnSignalRecords({ taskId: f.taskId, tagName: 'task-progress' }).length, 1);
    assert.equal(acct.modelNotice, noticeCallsAfterFirst, 'no extra model/run after duplicate publish');
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t2), f.taskId), 0, 'nothing on pin T2');
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t9), f.taskId), 0, 'nothing on usable T9');
    await assertC4Pin(f);
    recordVerdict('TN-ONCE-DUP', 'GREEN');
  } catch (err) {
    recordVerdict('TN-ONCE-DUP', 'RED', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await f.cleanup();
  }
});

test('TN-WRONG-THREAD-LIVE', { timeout: 90_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-WRONG-THREAD-LIVE')) return;
  await bridgeReset();
  await bridgeStart();
  const f = await buildFixture({ seedPin: 't9' });
  try {
    assert.equal(f.pinBefore, f.t9, 'pin started on usable T9');
    await assertThreadsUsable([f.t1, f.t2, f.t9]);
    await publishProgress(progressEvent(f));
    await waitFor('origin notice', async () => countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done') >= 1);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done'), 1);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t9), f.taskId), 0);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t2), f.taskId), 0, 'nothing on usable T2');
    await assertC4Pin(f, f.t9);
    recordVerdict('TN-WRONG-THREAD-LIVE', 'GREEN');
  } catch (err) {
    recordVerdict('TN-WRONG-THREAD-LIVE', 'RED', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await f.cleanup();
  }
});

test('TN-ORIGIN-MISSING-TASK', { timeout: 45_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-ORIGIN-MISSING-TASK')) return;
  await bridgeReset();
  await bridgeStart();
  const f = await buildFixture({ missingTask: true, seedPin: 't2' });
  try {
    await publishProgress(progressEvent(f, { chatTaskId: 'tn-does-not-exist' }));
    await waitFor('skip log', async () => bridgeLog.some((l) => JSON.stringify(l).includes('task-not-found')), 8_000);
    assert.equal(tnSignalRecords({ taskId: 'tn-does-not-exist' }).length, 0);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t2), 'tn-does-not-exist'), 0);
    recordVerdict('TN-ORIGIN-MISSING-TASK', 'GREEN');
  } catch (err) {
    recordVerdict('TN-ORIGIN-MISSING-TASK', 'RED', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await f.cleanup();
  }
});

test('TN-ORIGIN-MISSING-SOURCE', { timeout: 45_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-ORIGIN-MISSING-SOURCE')) return;
  await bridgeReset();
  await bridgeStart();
  const f = await buildFixture({ nullOrigin: true, seedPin: 't2' });
  try {
    await publishProgress(progressEvent(f));
    await waitFor('missing-origin log', async () => bridgeLog.some((l) => JSON.stringify(l).includes('missing-origin')), 8_000);
    assert.equal(tnSignalRecords({ taskId: f.taskId }).length, 0);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t2), f.taskId), 0);
    recordVerdict('TN-ORIGIN-MISSING-SOURCE', 'GREEN');
  } catch (err) {
    recordVerdict('TN-ORIGIN-MISSING-SOURCE', 'RED', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await f.cleanup();
  }
});

test('TN-ORIGIN-LOOKUP-COMPANY-SCOPE', { timeout: 60_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-ORIGIN-LOOKUP-COMPANY-SCOPE')) return;
  await bridgeReset();
  await bridgeStart();
  const f = await buildFixture({ extraTaskOnB: true, seedPin: 't2' });
  try {
    await publishProgress(
      progressEvent(f, {
        chatTaskId: f.taskIdB,
        companyId: f.companyId,
        agentId: f.agentId,
      }),
    );
    await waitFor('cross-scope skip', async () => bridgeLog.some((l) => JSON.stringify(l).includes('task-not-found')), 8_000);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t1b), f.taskIdB), 0, 'foreign origin not written');
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t1), f.taskIdB), 0);
    recordVerdict('TN-ORIGIN-LOOKUP-COMPANY-SCOPE', 'GREEN');
  } catch (err) {
    recordVerdict('TN-ORIGIN-LOOKUP-COMPANY-SCOPE', 'RED', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await f.cleanup();
  }
});

test('TN-MODEL-OVERRIDE-ISOLATION', { timeout: 60_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-MODEL-OVERRIDE-ISOLATION')) return;
  const f = await buildFixture();
  try {
    const chat = await import('@/lib/chat');
    const { db, agents } = await import('@tourbillon/db');
    const byRows = await db.select().from(agents);
    const by = byRows.find((r) => r.id === f.bystanderAgentId);
    assert.ok(by, 'bystander agent row');
    const controller = await chat.getOrCreateChatController(by as never);
    const session = await chat.getChatSession(controller, by as never, { threadId: `tn-by-${Date.now()}` });
    await session.sendMessage({ content: 'TN-BYSTANDER hello' });
    await waitFor('bystander model', async () => f.models.bystander.callLog.length >= 1, 15_000);
    assert.equal(f.models.a.callLog.length, 0, 'fixture A model unused by bystander');
    const { registerChatModelOverride } = await import('@tourbillon/mastra/chat');
    await assertC1ModelOnlyOverride(
      f.controllerA,
      f.recordA as { id: string; companyId: string },
      () => {
        registerChatModelOverride({ companyId: f.companyId, agentId: f.agentId }, { resolveModel: () => f.models.a.mock as never });
      },
      { threadId: f.t2 },
    );
    recordVerdict('TN-MODEL-OVERRIDE-ISOLATION', 'GREEN');
  } catch (err) {
    recordVerdict('TN-MODEL-OVERRIDE-ISOLATION', 'RED', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await f.cleanup();
  }
});

test('TN-SUBSCRIBE-ACK', { timeout: 30_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-SUBSCRIBE-ACK')) return;
  await bridgeReset();
  await bridgeStart();
  const handle = bridgeCurrentHandle();
  assert.ok(handle);
  await handle!.ready;
  recordVerdict('TN-SUBSCRIBE-ACK', 'GREEN');
});

test('TN-STOP-BEFORE-ACK', { timeout: 20_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-STOP-BEFORE-ACK')) return;
  await bridgeReset();
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const handle = await withAckGate(
    async () => startTaskProgressSignalBridge({ log: { warn: () => {} }, drainTimeoutMs: 800 }),
    gate,
  );
  const t0 = Date.now();
  const report = await handle.stop();
  const took = Date.now() - t0;
  release();
  assert.ok(took < 5_000, `stop-before-ACK settled in ${took}ms`);
  assert.equal((report as { timedOut?: boolean }).timedOut, false);
  await __resetTaskProgressSignalBridgeForTests();
  recordVerdict('TN-STOP-BEFORE-ACK', 'GREEN');
});

test('TN-STOP-BORROWED-CLIENTS', { timeout: 20_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-STOP-BORROWED-CLIENTS')) return;
  await bridgeReset();
  const client = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: 2 });
  let quitCalled = false;
  await bridgeStart({
    claimClient: {
      claim: async (key: string, ttl: number) => {
        const result = await client.set(key, '1', 'EX', ttl, 'NX');
        return result === 'OK';
      },
      quit: async () => {
        quitCalled = true;
      },
    },
  });
  const report = (await bridgeStop()) as { closedOwnedClients?: string[] };
  assert.equal(quitCalled, false, 'borrowed claim client was never quit');
  assert.equal((report.closedOwnedClients ?? []).includes('claim'), false);
  assert.equal(await client.ping(), 'PONG', 'the same borrowed client still answers PING');
  await client.quit();
  recordVerdict('TN-STOP-BORROWED-CLIENTS', 'GREEN');
});

test('TN-STOP-IDEMPOTENT', { timeout: 20_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-STOP-IDEMPOTENT')) return;
  await bridgeReset();
  const handle = startTaskProgressSignalBridge({ log: { warn: () => {} } });
  await handle.ready;
  const a = await handle.stop();
  const b = await handle.stop();
  assert.deepEqual(a, b);
  await __resetTaskProgressSignalBridgeForTests();
  recordVerdict('TN-STOP-IDEMPOTENT', 'GREEN');
});

test('TN-DRAIN-TIMEOUT', { timeout: 30_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-DRAIN-TIMEOUT')) return;
  // Control instrumentation only: tnSetQueueHold delays Session.queueSignal so
  // stop() can observe an admitted-but-unsettled delivery. This is NOT the
  // product default path. The pristine model-only default path is TN-DEFAULT-PATH,
  // which asserts tnQueueHoldActive() === false before and after delivery.
  await bridgeReset();
  await bridgeStart({ drainTimeoutMs: 800 });
  const f = await buildFixture({ seedPin: 't2' });
  try {
    assert.equal(tnQueueHoldActive(), false, 'hold is off until this control injects it');
    const hold = new Promise<void>(() => {});
    tnSetQueueHold(hold);
    assert.equal(tnQueueHoldActive(), true, 'TN-DRAIN-TIMEOUT injected queueSignal hold');
    await publishProgress(progressEvent(f));
    await waitFor('admitted', async () => tnSignalRecords({ taskId: f.taskId }).length >= 1, 8_000);
    const t0 = Date.now();
    let error: Error | null = null;
    try {
      await bridgeStop();
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
    }
    const took = Date.now() - t0;
    tnSetQueueHold(null);
    assert.ok(error, 'timeout must reject, never pass');
    assert.match(error!.message, /did not settle|drain|pending/i);
    const report = (error as { report?: { admitted?: number; completed?: number; pending?: number; unsettled?: unknown; timedOut?: boolean } }).report;
    assert.ok(report, 'stop rejection carries a report');
    assert.ok((report!.admitted ?? 0) >= 1, 'report.admitted');
    assert.ok(typeof report!.completed === 'number', 'report.completed');
    assert.ok(typeof report!.pending === 'number', 'report.pending');
    assert.ok(report!.unsettled !== undefined, 'report.unsettled');
    assert.equal(report!.timedOut, true);
    assert.ok(took < 6_000, `bounded drain ${took}ms`);
    recordVerdict('TN-DRAIN-TIMEOUT', 'GREEN');
  } catch (err) {
    tnSetQueueHold(null);
    recordVerdict('TN-DRAIN-TIMEOUT', 'RED', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    tnSetQueueHold(null);
    await f.cleanup();
    await bridgeReset();
  }
});

test('TN-RESTART-FRESH-CLIENTS', { timeout: 60_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-RESTART-FRESH-CLIENTS')) return;
  await bridgeReset();
  await bridgeStart();
  await bridgeStop();
  await bridgeStart();
  const f = await buildFixture({ seedPin: 't2' });
  try {
    await assertThreadsUsable([f.t2, f.t9]);
    await publishProgress(progressEvent(f));
    await waitFor('notice after restart', async () => countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done') >= 1);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t2), f.taskId), 0);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t9), f.taskId), 0);
    await assertC4Pin(f);
    recordVerdict('TN-RESTART-FRESH-CLIENTS', 'GREEN');
  } catch (err) {
    recordVerdict('TN-RESTART-FRESH-CLIENTS', 'RED', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await f.cleanup();
  }
});


test('TN-CONCURRENT-SAME-COMPANY-AGENTS', { timeout: 90_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-CONCURRENT-SAME-COMPANY-AGENTS')) return;
  await bridgeReset();
  await bridgeStart();
  let f: Awaited<ReturnType<typeof buildFixture>> | undefined;
  try {
    f = await buildFixture({ seedPin: 't2', secondAgentSameCompany: true });
    assert.ok(f.controllerC, 'same-company agent C controller');
    assert.notEqual(f.controllerA.id, f.controllerC!.id, 'distinct controllers for two agents in one company');
    const chatSame = await import('@/lib/chat');
    assert.notEqual(chatSame.chatControllerId(f.agentId), chatSame.chatControllerId(f.agentIdC), 'distinct controller cache keys');
    const sameA = sessionIdentityOf(f.userSession);
    const sameC = sessionIdentityOf(await chatSame.getChatSession(f.controllerC as never, f.recordC as never, { threadId: f.t1c }));
    assert.equal(sameA.resourceId, sameC.resourceId, 'same-company agents share resource id');
    const ownerA = sameA.ownerId || String(f.controllerA.id);
    const ownerC = sameC.ownerId || String(f.controllerC!.id);
    assert.notEqual(ownerA, ownerC, 'distinct session hosts (same company)');
    await assertThreadsUsable([f.t1, f.t1c, f.t2, f.t9]);
    await publishProgress(progressEvent(f, { runId: 'run-a' }));
    await publishProgress(progressEvent({ companyId: f.companyId, agentId: f.agentIdC, taskId: f.taskIdC }, { runId: 'run-c' }));
    await waitFor('A own notice', async () => countNoticeMessages(await tnFreshMessages(f!.t1), f!.taskId, 'done') >= 1);
    await waitFor('C own notice', async () => countNoticeMessages(await tnFreshMessages(f!.t1c), f!.taskIdC, 'done') >= 1);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done'), 1, 'exact one notice for A');
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t1c), f.taskIdC, 'done'), 1, 'exact one notice for C');
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t1), f.taskIdC), 0, 'no same-company cross-agent leak onto A');
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t1c), f.taskId), 0, 'no same-company cross-agent leak onto C');
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t9), f.taskId), 0, 'nothing on usable T9 for A');
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t9), f.taskIdC), 0, 'nothing on usable T9 for C');
    await assertC4Pin(f);
    recordVerdict('TN-CONCURRENT-SAME-COMPANY-AGENTS', 'GREEN');
  } catch (err) {
    recordVerdict('TN-CONCURRENT-SAME-COMPANY-AGENTS', 'RED', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await f?.cleanup();
  }
});

test('TN-START-CONCURRENT', { timeout: 30_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-START-CONCURRENT')) return;
  await bridgeReset();
  const first = startTaskProgressSignalBridge({ log: { warn: () => {} } });
  const second = startTaskProgressSignalBridge({ log: { warn: () => {} } });
  await first.ready;
  await second.ready;
  await first.stop();
  await second.stop().catch(() => {});
  await __resetTaskProgressSignalBridgeForTests();
  recordVerdict('TN-START-CONCURRENT', 'GREEN');
});

test('TN-CLAIM-FAIL-OPEN', { timeout: 90_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-CLAIM-FAIL-OPEN')) return;
  await bridgeReset();
  await bridgeStart({
    claimClient: redisClaimClient({
      set: async () => {
        throw new Error('injected claim failure');
      },
    }),
  });
  const f = await buildFixture({ seedPin: 't2' });
  try {
    await assertThreadsUsable([f.t2, f.t9]);
    await publishProgress(progressEvent(f));
    await waitFor('fail-open still delivers', async () => countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done') >= 1);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done'), 1);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t2), f.taskId), 0);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t9), f.taskId), 0);
    await assertC4Pin(f);
    recordVerdict('TN-CLAIM-FAIL-OPEN', 'GREEN');
  } catch (err) {
    recordVerdict('TN-CLAIM-FAIL-OPEN', 'RED', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await f.cleanup();
  }
});

test('TN-DRAIN-SUCCESS', { timeout: 60_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-DRAIN-SUCCESS')) return;
  await bridgeReset();
  await bridgeStart();
  const f = await buildFixture({ seedPin: 't2' });
  try {
    await assertThreadsUsable([f.t2, f.t9]);
    await publishProgress(progressEvent(f));
    await waitFor('notice before successful drain', async () => countNoticeMessages(await tnFreshMessages(f.t1), f.taskId, 'done') >= 1);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t2), f.taskId), 0);
    assert.equal(countNoticeMessages(await tnFreshMessages(f.t9), f.taskId), 0);
    await assertC4Pin(f);
    const report = (await bridgeStop()) as { admitted?: number; completed?: number; timedOut?: boolean; pending?: number };
    assert.equal(report.timedOut, false);
    assert.ok((report.admitted ?? 0) >= 1);
    assert.ok((report.completed ?? 0) >= 1);
    recordVerdict('TN-DRAIN-SUCCESS', 'GREEN');
  } catch (err) {
    recordVerdict('TN-DRAIN-SUCCESS', 'RED', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await f.cleanup();
    await bridgeReset();
  }
});

test('TN-SUBSCRIBE-DELAYED-ACK', { timeout: 20_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-SUBSCRIBE-DELAYED-ACK')) return;
  await bridgeReset();
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const handle = await withAckGate(
    async () => startTaskProgressSignalBridge({ log: { warn: () => {} } }),
    gate,
  );
  let ready = false;
  const readyWait = handle.ready.then(() => {
    ready = true;
  });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(ready, false, 'ready must not resolve before ACK');
  release();
  await readyWait;
  assert.equal(ready, true);
  await handle.stop();
  await __resetTaskProgressSignalBridgeForTests();
  recordVerdict('TN-SUBSCRIBE-DELAYED-ACK', 'GREEN');
});


test('TN-START-FAIL-RETRY', { timeout: 30_000 }, async (t) => {
  if (await skipIfIncompatible(t, 'TN-START-FAIL-RETRY')) return;
  await bridgeReset();
  const leaked: Redis[] = [];
  try {
    const handle1 = startTaskProgressSignalBridge({
      log: { warn: () => {} },
      createSubscriber: () => {
        const client = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: 1 });
        leaked.push(client);
        client.psubscribe = (async () => {
          throw new Error('injected subscribe failure');
        }) as typeof client.psubscribe;
        return client;
      },
    });
    await assert.rejects(() => handle1.ready, /injected subscribe failure/);
    await __resetTaskProgressSignalBridgeForTests();
    const handle2 = startTaskProgressSignalBridge({ log: { warn: () => {} } });
    await handle2.ready;
    await handle2.stop();
    await __resetTaskProgressSignalBridgeForTests();
    recordVerdict('TN-START-FAIL-RETRY', 'GREEN');
  } catch (err) {
    recordVerdict('TN-START-FAIL-RETRY', 'RED', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await Promise.all(leaked.map((c) => c.quit().catch(() => c.disconnect())));
  }
});

test('TN-FAIL-CLEAN-INNER', { timeout: 5_000 }, () => {
  if (process.env.TN_FAIL_CLEAN === '1') {
    assert.equal(1, 2, 'deliberate failing control');
  }
});

test('TN-FAIL-CLEAN-CONTROL', { timeout: 90_000 }, () => {
  if (!isFixedCapable()) {
    recordVerdict('TN-FAIL-CLEAN-CONTROL', INCOMPAT, capability.reason.join('; '));
    return;
  }
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      '--test-name-pattern=^TN-FAIL-CLEAN-INNER$',
      fileURLToPath(new URL('./task-notification-fail-clean-child.test.ts', import.meta.url)),
    ],
    {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_PATH: process.env.NODE_PATH,
        NODE_ENV: process.env.NODE_ENV ?? 'test',
        DATABASE_URL: process.env.DATABASE_URL,
        REDIS_URL: process.env.REDIS_URL,
        TN_DISPOSABLE: '1',
        TOURBILLON_AGENT_TOKEN_SECRET: process.env.TOURBILLON_AGENT_TOKEN_SECRET,
      },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  assert.notEqual(
    child.status,
    0,
    `failing assertion must be non-zero (status=${child.status} signal=${child.signal} stdout=${child.stdout} stderr=${child.stderr})`,
  );
  assert.notEqual(child.status, 143, 'must not be watchdog SIGTERM');
  assert.equal(child.signal, null);
  recordVerdict('TN-FAIL-CLEAN-CONTROL', 'GREEN');
});

test('TN-TEARDOWN', { timeout: 20_000 }, async () => {
  const admin = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: 1 });
  const baseline = Number(await admin.call('PUBSUB', 'NUMPAT'));
  await bridgeReset();
  await tnTeardown();
  persistVerdicts();
  const after = Number(await admin.call('PUBSUB', 'NUMPAT'));
  assert.ok(after <= baseline, `NUMPAT after teardown ${after} <= baseline ${baseline}`);
  await admin.quit();
  recordVerdict('TN-TEARDOWN', 'GREEN');
});
