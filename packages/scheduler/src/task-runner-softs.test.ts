/**
 * #205 ACCEPT softs — TASK-RUNNER progress publishing, runtime.
 *
 * S3 (carried from #196, restated at the ACCEPT): the publisher literal was only type-pinned.
 * A mutant with `type: 'task_run_update'` inside the JSON.stringify of the DEFAULT emitProgress
 * survived every test (the fake-deps poll tests inject their own emitProgress, so the real
 * publisher body was never executed). These tests drive the PRODUCTION emit path —
 * createDefaultTaskRunnerDeps' default emitProgress, and pollTaskRunner using it — and assert
 * the parsed envelope on the wire: channel `sse:{companyId}`, literal type
 * 'chat_task_progress', and exactly the ChatTaskProgressEvent fields. Reverting the literal
 * (or dropping `type`) goes RED at runtime, not just at tsc.
 *
 * redis-pub eagerly creates an ioredis client at module load, so './redis' is stubbed in the
 * require cache first (same portable pattern as scheduler-main.test.ts from #208 — tsx runs
 * these as CJS, so the emitProgress dynamic import resolves through require).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  createDefaultTaskRunnerDeps,
  pollTaskRunner,
  type ChatTaskProgressEvent,
  type TaskRunnerDeps,
} from './task-runner';
import type { ChatTaskDb, RunnableChatTaskRow } from '@tourbillon/db';
import type { WakeResult } from './wake-runner';

// task-runner.ts imports @tourbillon/db at module load, which validates DATABASE_URL eagerly.
process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused';

interface Published {
  channel: string;
  payload: string;
}
const published: Published[] = [];

const fakeRedisClient = {
  publish: (channel: string, payload: string) => {
    published.push({ channel, payload });
    return Promise.resolve(1);
  },
  disconnect: () => undefined,
  on: () => fakeRedisClient,
};
{
  const require_ = createRequire(import.meta.url);
  const redisPath = require_.resolve('./redis');
  const stub = {
    id: redisPath,
    filename: redisPath,
    loaded: true,
    exports: { createConnection: () => fakeRedisClient, connection: fakeRedisClient },
    children: [],
    paths: [],
  } as unknown as NodeJS.Require['cache'][string];
  require_.cache[redisPath] = stub;
}

/** emitProgress is fire-and-forget behind a dynamic import — let the microtasks drain. */
const settle = () => new Promise((r) => setTimeout(r, 50));

function progressEvent(over: Partial<ChatTaskProgressEvent> = {}): ChatTaskProgressEvent {
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

function runnableRow(over: Partial<RunnableChatTaskRow> = {}): RunnableChatTaskRow {
  return {
    taskId: 'task-1',
    companyId: 'company-1',
    agentId: 'agent-1',
    title: 'Ship the runbook',
    notes: null,
    position: 0,
    attempts: 0,
    paused: false,
    sourceThreadId: null,
    agentName: 'Ada',
    agentUrlKey: 'ada',
    agentStatus: 'active',
    companyStatus: 'active',
    companySettings: null,
    ...over,
  } as RunnableChatTaskRow;
}

/** The production deps with only the I/O seams faked — emitProgress stays the REAL publisher. */
function depsWithRealPublisher(
  overrides: Partial<TaskRunnerDeps> = {},
): TaskRunnerDeps {
  const base = createDefaultTaskRunnerDeps({ database: {} as unknown as ChatTaskDb });
  return {
    ...base,
    db: {} as unknown as ChatTaskDb,
    log: { info: () => undefined },
    listRunnable: async () => [runnableRow()],
    countActiveRuns: async () => ({ total: 0, task: 0 }),
    claim: async () => true,
    settle: async () => undefined,
    startWake: async (job) => ({ runId: job.runId ?? 'run-1', status: 'succeeded' }) as WakeResult,
    ...overrides,
  };
}

test('S3: the DEFAULT emitProgress publishes the pinned chat_task_progress envelope', async () => {
  published.length = 0;
  const deps = createDefaultTaskRunnerDeps({ database: {} as unknown as ChatTaskDb });
  assert.ok(deps.emitProgress, 'default deps always carry the production publisher');

  const event = progressEvent();
  deps.emitProgress!(event);
  await settle();

  assert.equal(published.length, 1, 'exactly one publish per emitted event');
  assert.equal(published[0]!.channel, 'sse:company-1', 'company SSE channel');
  // Literal wire contract — a mutant `type: 'task_run_update'` inside JSON.stringify lands here.
  assert.deepEqual(JSON.parse(published[0]!.payload), {
    type: 'chat_task_progress',
    companyId: 'company-1',
    agentId: 'agent-1',
    chatTaskId: 'task-1',
    runId: 'run-1',
    stage: 'started',
    status: 'running',
    title: 'Ship the runbook',
  });
});

test('S3: pollTaskRunner through the real publisher emits started → done, both pinned', async () => {
  published.length = 0;
  const deps = depsWithRealPublisher();
  const summary = await pollTaskRunner(deps, { maxConcurrentRuns: 4 });
  assert.equal(summary.started.length, 1);
  await summary.started[0]!.done;
  await settle();

  assert.equal(published.length, 2, 'started on claim, terminal stage after the run settles');
  for (const p of published) assert.equal(p.channel, 'sse:company-1');

  const started = JSON.parse(published[0]!.payload);
  const finished = JSON.parse(published[1]!.payload);
  assert.equal(started.type, 'chat_task_progress', 'started envelope keeps the pinned type');
  assert.equal(started.stage, 'started');
  assert.equal(started.status, 'running');
  assert.equal(finished.type, 'chat_task_progress', 'terminal envelope keeps the pinned type');
  assert.equal(finished.stage, 'done', 'succeeded run reports the done stage');
  assert.equal(finished.status, 'succeeded');
  assert.equal(finished.chatTaskId, 'task-1');
  assert.equal(finished.runId, summary.started[0]!.runId, 'progress carries the claim runId');

  // No extra fields leak into the chip payload beyond type + ChatTaskProgressEvent.
  assert.deepEqual(Object.keys(started).sort(), [
    'agentId',
    'chatTaskId',
    'companyId',
    'runId',
    'stage',
    'status',
    'title',
    'type',
  ]);
});

test('S3: a FAILED run still publishes through the real path, needs_review + failed', async () => {
  published.length = 0;
  const deps = depsWithRealPublisher({
    startWake: async (job) =>
      ({ runId: job.runId ?? 'run-1', status: 'failed', errorText: 'model exploded' }) as WakeResult,
  });
  const summary = await pollTaskRunner(deps, { maxConcurrentRuns: 4 });
  await summary.started[0]!.done;
  await settle();

  assert.equal(published.length, 2);
  const finished = JSON.parse(published[1]!.payload);
  assert.equal(finished.type, 'chat_task_progress');
  assert.equal(finished.stage, 'needs_review');
  assert.equal(finished.status, 'failed');
});
