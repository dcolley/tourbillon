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
  agentArchivedKillError,
  forceKillTermination,
  parseForceKillReason,
} from './heartbeat-abort';
import { AGENT_ARCHIVED_RUN_ERROR } from '@tourbillon/shared';

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

describe('Archive agent: force-kill with reason agent_archived', () => {
  it('parseForceKillReason: absent → operator kill; agent_archived accepted; anything else refused', () => {
    assert.deepEqual(parseForceKillReason(undefined), { ok: true });
    assert.deepEqual(parseForceKillReason(null), { ok: true });
    assert.deepEqual(parseForceKillReason('agent_archived'), { ok: true, reason: 'agent_archived' });
    assert.deepEqual(parseForceKillReason('operator'), { ok: false });
    assert.deepEqual(parseForceKillReason({ reason: 'agent_archived' }), { ok: false });
  });

  it('forceKillTermination: operator kill unchanged (failed + operator reason)', () => {
    const t = forceKillTermination();
    assert.equal(t.status, 'failed');
    assert.equal(t.errorText, OPERATOR_FORCE_KILL_REASON);
    assert.equal(t.abortError.message, OPERATOR_FORCE_KILL_REASON);
  });

  it('forceKillTermination: agent_archived → cancelled with the agent_archived reason', () => {
    const t = forceKillTermination('agent_archived');
    assert.equal(t.status, 'cancelled');
    assert.equal(t.errorText, AGENT_ARCHIVED_RUN_ERROR);
    assert.match(t.errorText, /agent_archived/);
    assert.equal(t.abortError.message, AGENT_ARCHIVED_RUN_ERROR);
  });

  it('a run aborted because its agent was archived reports the archive reason, not a stale/abort error', () => {
    const controller = new AbortController();
    controller.abort(agentArchivedKillError());
    assert.equal(
      resolveHeartbeatFailureError(new Error('The operation was aborted'), true, controller.signal.reason),
      AGENT_ARCHIVED_RUN_ERROR,
    );
  });
});
