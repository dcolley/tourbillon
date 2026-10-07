import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canForceKillHeartbeat, canRetryFailedHeartbeat } from './heartbeat-liveness';

describe('canForceKillHeartbeat', () => {
  it('returns true for queued status', () => {
    assert.equal(canForceKillHeartbeat('queued'), true);
  });

  it('returns true for running status', () => {
    assert.equal(canForceKillHeartbeat('running'), true);
  });

  it('returns false for succeeded status', () => {
    assert.equal(canForceKillHeartbeat('succeeded'), false);
  });

  it('returns false for failed status', () => {
    assert.equal(canForceKillHeartbeat('failed'), false);
  });

  it('returns false for cancelled status', () => {
    assert.equal(canForceKillHeartbeat('cancelled'), false);
  });

  it('returns false for coalesced status', () => {
    assert.equal(canForceKillHeartbeat('coalesced'), false);
  });

  it('returns false for unknown status', () => {
    assert.equal(canForceKillHeartbeat('unknown'), false);
  });
});

describe('canRetryFailedHeartbeat', () => {
  it('returns true for failed status', () => {
    assert.equal(canRetryFailedHeartbeat('failed'), true);
  });

  it('returns false for queued status', () => {
    assert.equal(canRetryFailedHeartbeat('queued'), false);
  });

  it('returns false for running status', () => {
    assert.equal(canRetryFailedHeartbeat('running'), false);
  });

  it('returns false for succeeded status', () => {
    assert.equal(canRetryFailedHeartbeat('succeeded'), false);
  });

  it('returns false for cancelled status', () => {
    assert.equal(canRetryFailedHeartbeat('cancelled'), false);
  });

  it('returns false for coalesced status', () => {
    assert.equal(canRetryFailedHeartbeat('coalesced'), false);
  });

  it('returns false for unknown status', () => {
    assert.equal(canRetryFailedHeartbeat('unknown'), false);
  });
});
