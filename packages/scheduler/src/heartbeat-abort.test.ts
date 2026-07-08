import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HEARTBEAT_ABORTED,
  abortRejectedPromise,
  awaitWithAbort,
  isAbortLikeError,
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
