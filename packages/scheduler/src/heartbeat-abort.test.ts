import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HEARTBEAT_ABORTED,
  abortRejectedPromise,
  awaitWithAbort,
  isAbortLikeError,
  resolveHeartbeatFailureError,
  operatorForceKillError,
  OPERATOR_FORCE_KILL_REASON,
} from './heartbeat-abort';

describe('isAbortLikeError', () => {
  it('detects undici terminated errors', () => {
    assert.equal(isAbortLikeError(new TypeError('terminated')), true);
  });

  it('detects heartbeat aborted errors', () => {
    assert.equal(isAbortLikeError(new Error(HEARTBEAT_ABORTED)), true);
  });
});

describe('awaitWithAbort', () => {
  it('rejects when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => awaitWithAbort(new Promise<string>(() => undefined), controller.signal),
      (err: Error) => err.message === HEARTBEAT_ABORTED,
    );
  });

  it('rejects when signal aborts before work settles', async () => {
    const controller = new AbortController();
    const pending = new Promise<string>(() => undefined);
    const raced = awaitWithAbort(pending, controller.signal);
    controller.abort();
    await assert.rejects(raced, (err: Error) => err.message === HEARTBEAT_ABORTED);
  });
});

describe('abortRejectedPromise', () => {
  it('rejects immediately when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(abortRejectedPromise(controller.signal));
  });
});

describe('resolveHeartbeatFailureError', () => {
  it('returns operator kill text when abort reason is operator kill', () => {
    const err = new Error('any error');
    const result = resolveHeartbeatFailureError(err, true, operatorForceKillError());
    assert.equal(result, OPERATOR_FORCE_KILL_REASON);
  });

  it('returns operator kill text even when aborted is false but reason is operator kill', () => {
    const err = new Error('any error');
    const result = resolveHeartbeatFailureError(err, false, operatorForceKillError());
    assert.equal(result, OPERATOR_FORCE_KILL_REASON);
  });

  it('returns stale text when aborted is true without operator reason', () => {
    const err = new Error('any error');
    const result = resolveHeartbeatFailureError(err, true);
    assert.ok(result.includes('stopped responding'));
  });

  it('returns stale text for abort-like errors without operator reason', () => {
    const err = new Error(HEARTBEAT_ABORTED);
    const result = resolveHeartbeatFailureError(err, false);
    assert.ok(result.includes('stopped responding'));
  });

  it('returns error message for non-abort errors', () => {
    const err = new Error('Custom error message');
    const result = resolveHeartbeatFailureError(err, false);
    assert.equal(result, 'Custom error message');
  });

  it('returns timeout message for timeout errors', () => {
    const err = new Error('Heartbeat timeout');
    const result = resolveHeartbeatFailureError(err, false);
    assert.equal(result, 'Heartbeat timeout');
  });

  it('converts non-Error to string', () => {
    const result = resolveHeartbeatFailureError('plain string error', false);
    assert.equal(result, 'plain string error');
  });
});
