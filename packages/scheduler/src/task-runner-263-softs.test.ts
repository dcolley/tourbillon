/**
 * S263-S1 / S263-S3 (#263 softs): the PRODUCTION wiring pins for the TASK-AUDIT lifecycle rows.
 *
 * The Test gate (#263) found two silent-regression holes:
 *  - M14: dropping `logActivity` from `createDefaultTaskRunnerDeps` left every suite green —
 *    the Activity "Tasks" filter would lose all runner rows in prod with nobody noticing.
 *  - the sweep's audit write was swallowed: a broken insert on the stale-run sweep path never
 *    logged (only the poller's own rows did).
 * Both are pinned here against fake databases — no Postgres, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { activityLog, type ChatTaskDb } from '@tourbillon/db';
import {
  createDefaultTaskRunnerDeps,
  sweepStaleChatTaskRuns,
  type ChatTaskActivityEvent,
} from './task-runner';
import { fakeReconcileDb, staleRow } from './__fixtures__/fake-reconcile-db';

process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused';

/** Capture shape: recordChatTaskActivity's `database.insert(table).values(row)`. */
function insertSpy(over: { fail?: boolean } = {}) {
  const inserts: Array<{ table: unknown; row: Record<string, unknown> }> = [];
  const database = {
    insert: (table: unknown) => ({
      values: async (row: Record<string, unknown>) => {
        if (over.fail) throw new Error('activity db down');
        inserts.push({ table, row });
        return [row];
      },
    }),
  };
  return { db: database as unknown as ChatTaskDb, inserts };
}

function event(over: Partial<ChatTaskActivityEvent> = {}): ChatTaskActivityEvent {
  return {
    companyId: 'c1',
    agentId: 'a1',
    chatTaskId: 't1',
    runId: 'r1',
    title: 'Ship the runbook',
    action: 'chat_task.done',
    status: 'done',
    productStatus: 'done',
    previousStatus: 'in_progress',
    attempts: 2,
    ...over,
  };
}

function logSpy(): {
  log: NonNullable<ReturnType<typeof createDefaultTaskRunnerDeps>['log']>;
  warns: Array<{ msg: string; data?: Record<string, unknown> }>;
  infos: Array<{ msg: string; data?: Record<string, unknown> }>;
} {
  const warns: Array<{ msg: string; data?: Record<string, unknown> }> = [];
  const infos: Array<{ msg: string; data?: Record<string, unknown> }> = [];
  return {
    log: {
      info: (msg, data) => infos.push({ msg, data }),
      warn: (msg, data) => warns.push({ msg, data }),
    },
    warns,
    infos,
  };
}

test('S263-S1 (M14): createDefaultTaskRunnerDeps wires logActivity — a runner event writes one system activity_log row', async () => {
  const spy = insertSpy();
  const deps = createDefaultTaskRunnerDeps({ database: spy.db, log: logSpy().log });
  // M14 mutant: `logActivity` removed from the default deps → undefined → RED here. Every
  // existing suite passed with it unwired, so this pin is the only prod-wiring guard.
  assert.equal(typeof deps.logActivity, 'function', 'production default deps must wire logActivity');

  await deps.logActivity!(event());

  assert.equal(spy.inserts.length, 1, 'one activity_log row per transition');
  const { table, row } = spy.inserts[0]!;
  assert.equal(table, activityLog, 'the row goes to activity_log');
  assert.equal(row.companyId, 'c1');
  assert.equal(row.entityType, 'chat_task');
  assert.equal(row.entityId, 't1');
  assert.equal(row.action, 'chat_task.done');
  assert.equal(row.actorType, 'system', 'runner rows are system-acted…');
  assert.equal(row.actorId, 'task-runner', '…with the writer named task-runner, never the agent');
  // The Activity view links the owning agent and the run off details (M12's pairing).
  const details = row.details as Record<string, unknown>;
  assert.equal(details.agentId, 'a1');
  assert.equal(details.runId, 'r1');
  assert.equal(details.title, 'Ship the runbook');
  assert.equal(details.status, 'done');
  assert.equal(details.productStatus, 'done');
  assert.equal(details.previousStatus, 'in_progress');
  assert.equal(details.previousProductStatus, 'running', 'the from-side product word rides on the row');
  assert.equal(details.attempts, 2);
});

test('S263-S1: previousStatus / previousProductStatus ride ONLY when the event has a prior status', async () => {
  const spy = insertSpy();
  const deps = createDefaultTaskRunnerDeps({ database: spy.db, log: logSpy().log });
  await deps.logActivity!(event({ previousStatus: undefined }));
  const details = spy.inserts[0]!.row.details as Record<string, unknown>;
  assert.ok(!('previousStatus' in details), 'no prior state → no phantom from-side');
  assert.ok(!('previousProductStatus' in details));
});

test('S263-S1 + S3: the default logActivity onError logs, never throws (prod best-effort is loud, not silent)', async () => {
  const spy = insertSpy({ fail: true });
  const { log, warns, infos } = logSpy();
  const deps = createDefaultTaskRunnerDeps({ database: spy.db, log });
  await assert.doesNotReject(() => Promise.resolve(deps.logActivity!(event())), 'a broken audit insert never breaks the queue');
  const hit = warns.find((w) => w.msg === 'task-run activity log failed') ?? infos.find((w) => w.msg === 'task-run activity log failed');
  assert.ok(hit, 'the failed write is logged through the deps logger');
  assert.equal((hit!.data as Record<string, unknown>).chatTaskId, 't1');
});

test('S263-S3: the stale-run sweep surfaces a failed audit write (warn) and still settles every lost run', async () => {
  const f = fakeReconcileDb({
    stale: [staleRow({ taskId: 't-lost', attempts: 1 }), staleRow({ taskId: 't-dead', attempts: 2 })],
    withActivity: true,
    failActivity: true, // every activity insert throws
  });
  const { log, warns, infos } = logSpy();
  const result = await sweepStaleChatTaskRuns(f.db, { log });

  assert.equal(result.requeued, 1, 'the re-queue still happens…');
  assert.equal(result.parked, 1, '…and the park too — audit failure never blocks the settle');
  assert.equal(f.activity.length, 0, 'nothing landed in activity_log');
  const failed = [...warns, ...infos].filter((w) => w.msg === 'task-run activity log failed');
  assert.equal(failed.length, 2, 'one loud failure per lost audit row (previously silent)');
  assert.deepEqual(
    failed.map((w) => (w.data as Record<string, unknown>).chatTaskId).sort(),
    ['t-dead', 't-lost'],
  );
  assert.ok(
    failed.every((w) => (w.data as Record<string, unknown>).error === 'activity db down'),
    'the underlying error travels with the log line',
  );
});
