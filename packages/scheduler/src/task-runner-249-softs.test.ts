/**
 * S249-S3 (#249 ACCEPT soft-pack): the cap-0 refusal must name the REAL remedy.
 *
 * S245-S3b shipped "…or set a company taskRunner.maxConcurrentTasks ≥ 1 with budget headroom".
 * But resolveTaskRunnerSettings (packages/shared) CLAMPS maxConcurrentTasks into [1, 8] — an
 * operator can never OBSERVE a company setting below 1, so that half of the copy pointed at a
 * knob that cannot be the cause of an effective task cap of 0. The only real remedies are the
 * shared budget (TASK_RUNNER_MAX_CONCURRENT_RUNS ≥ 2, so defaultTaskCapPerAgent leaves a slot
 * after the heartbeat reservation) or an explicit opts.taskCap. Wording-only change; this pin
 * keeps the trimmed copy honest in BOTH directions: it must still name the budget env and the
 * explicit override (match), and must never resurrect the clamped company setting (doesNotMatch).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pollTaskRunner, type TaskRunnerDeps } from './task-runner';
import type { RunnableChatTaskRow } from '@tourbillon/db';

// task-runner.ts imports @tourbillon/db at module load, which validates DATABASE_URL eagerly.
process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1/unused';

function row(): RunnableChatTaskRow {
  return {
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
  } as unknown as RunnableChatTaskRow;
}

test('S249-S3: cap-0 refusal names budget + opts.taskCap and never the clamped company setting', async () => {
  const warns: Array<{ msg: string; data?: Record<string, unknown> }> = [];
  const deps = {
    db: null as unknown as TaskRunnerDeps['db'],
    listRunnable: async () => [row()],
    countActiveRuns: async () => ({ total: 0, task: 0 }),
    claim: async () => true,
    startWake: async () => {
      throw new Error('cap-0 must never reach a wake');
    },
    settle: async () => {},
    log: {
      info: () => {},
      warn: (msg: string, data?: Record<string, unknown>) => warns.push({ msg, data }),
    },
  } as unknown as TaskRunnerDeps;

  // Budget 1 → defaultTaskCapPerAgent(1) = 0: the documented cap-0 shape.
  const s = await pollTaskRunner(deps, { maxConcurrentRuns: 1 });
  assert.equal(s.skippedNoCapacity, 1, 'the refusal path itself must still fire');

  const refusal = warns.find((l) => /task-run capacity zero, refusing/.test(l.msg));
  assert.ok(refusal, 'cap-0 still gets its honest refusal line');
  assert.match(refusal.msg, /TASK_RUNNER_MAX_CONCURRENT_RUNS/, 'names the shared-budget env');
  assert.match(refusal.msg, /opts\.taskCap/, 'names the explicit override as the other real remedy');
  // The wrong suggestion must stay dead: maxConcurrentTasks is clamped ≥ 1 upstream, so
  // telling operators to raise it ≥ 1 is a red herring (restoring the old copy REDs here).
  assert.doesNotMatch(
    refusal.msg,
    /maxConcurrentTasks/,
    'company taskRunner.maxConcurrentTasks is clamped to [1, 8] — it can never be below 1, ' +
      'so the remedy must not point operators at it',
  );
});
