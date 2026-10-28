/**
 * S1 (#196 follow-up): resolveTaskRunnerSettings is WIRED, not dead — the scheduler poller
 * reads it every tick (packages/scheduler/src/task-runner.ts). These tests pin the live
 * contract: defaults when unset, per-field clamps (never trust jsonb raw), and the S4 SSE
 * type name matching what the scheduler actually publishes on `sse:{companyId}`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveTaskRunnerSettings } from './types';

const settings = (taskRunner: unknown) =>
  resolveTaskRunnerSettings({ taskRunner: taskRunner as never });

describe('resolveTaskRunnerSettings (S1: wired company config)', () => {
  it('defaults when nothing is set', () => {
    const expected = { enabled: true, maxConcurrentTasks: 2, maxAttemptsPerTask: 2 };
    assert.deepEqual(resolveTaskRunnerSettings(null), expected);
    assert.deepEqual(resolveTaskRunnerSettings(undefined), expected);
    assert.deepEqual(resolveTaskRunnerSettings({}), expected);
    assert.deepEqual(settings(undefined), expected);
    // jsonb garbage never throws and never disables (only explicit false does).
    assert.deepEqual(settings('nope'), expected);
    assert.deepEqual(settings([]), expected);
    assert.deepEqual(settings({ taskRunner: 'nope' }), expected);
  });

  it('enabled=false is the company master switch; anything else stays enabled', () => {
    assert.equal(settings({ enabled: false }).enabled, false);
    assert.equal(settings({ enabled: true }).enabled, true);
    assert.equal(settings({ enabled: 0 }).enabled, true); // only the literal false disables
    assert.equal(settings({ enabled: 'false' }).enabled, true);
  });

  it('clamps every number — floors, ceilings, truncation, garbage back to defaults', () => {
    assert.equal(settings({ maxConcurrentTasks: 0 }).maxConcurrentTasks, 1);
    assert.equal(settings({ maxConcurrentTasks: -5 }).maxConcurrentTasks, 1);
    assert.equal(settings({ maxConcurrentTasks: 99 }).maxConcurrentTasks, 8);
    assert.equal(settings({ maxConcurrentTasks: 2.7 }).maxConcurrentTasks, 2);
    assert.equal(settings({ maxConcurrentTasks: 4 }).maxConcurrentTasks, 4);
    assert.equal(settings({ maxConcurrentTasks: 'x' }).maxConcurrentTasks, 2);
    assert.equal(settings({ maxAttemptsPerTask: 0 }).maxAttemptsPerTask, 1);
    assert.equal(settings({ maxAttemptsPerTask: 9 }).maxAttemptsPerTask, 5);
    assert.equal(settings({ maxAttemptsPerTask: 3 }).maxAttemptsPerTask, 3);
    assert.equal(settings({ maxAttemptsPerTask: null }).maxAttemptsPerTask, 2);
  });
});

describe('SSEEventType (S4: the enum matches the wire)', () => {
  it("the task-runner progress type is 'chat_task_progress' — what the scheduler emits", () => {
    // The scheduler publishes { type: 'chat_task_progress', ... } on `sse:{companyId}`
    // (packages/scheduler/src/task-runner.ts emitProgress). If either side renames, this
    // string is the contract; the old dead 'task_run_update' member must not come back.
    const emitted = 'chat_task_progress' as const;
    const type: import('./types').SSEEventType = emitted;
    assert.equal(type, 'chat_task_progress');
  });
});
