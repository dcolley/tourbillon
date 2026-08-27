import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canForceKillHeartbeat } from './heartbeat-liveness';

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
