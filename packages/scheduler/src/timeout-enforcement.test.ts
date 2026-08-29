import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveHeartbeatFailureError } from './heartbeat-abort';

describe('Timeout enforcement error handling', () => {
  it('extracts wall-clock timeout from abort reason', () => {
    const abortReason = new Error('Heartbeat exceeded wall-clock timeout of 60s');
    const result = resolveHeartbeatFailureError(
      new Error('aborted'),
      true,
      abortReason
    );
    
    assert.equal(result, 'Heartbeat exceeded wall-clock timeout of 60s');
  });

  it('extracts wall-clock timeout with default 300s', () => {
    const abortReason = new Error('Heartbeat exceeded wall-clock timeout of 300s');
    const result = resolveHeartbeatFailureError(
      new Error('aborted'),
      true,
      abortReason
    );
    
    assert.equal(result, 'Heartbeat exceeded wall-clock timeout of 300s');
  });

  it('extracts wall-clock timeout from error when abort reason is missing', () => {
    const error = new Error('Heartbeat exceeded wall-clock timeout of 90s');
    const result = resolveHeartbeatFailureError(error, true, undefined);
    
    assert.equal(result, 'Heartbeat exceeded wall-clock timeout of 90s');
  });

  it('prioritizes operator force-kill over wall-clock timeout', () => {
    const abortReason = new Error('Force-killed by operator');
    const result = resolveHeartbeatFailureError(
      new Error('Heartbeat exceeded wall-clock timeout of 60s'),
      true,
      abortReason
    );
    
    assert.equal(result, 'Force-killed by operator');
  });

  it('falls back to staleness error when no specific timeout message', () => {
    const result = resolveHeartbeatFailureError(
      new Error('aborted'),
      true,
      undefined
    );
    
    // Should use staleness error (not timeout)
    assert.match(result, /stopped responding/);
  });

  it('timeout error must quote the configured value not a hardcoded 1200', () => {
    const abortReason = new Error('Heartbeat exceeded wall-clock timeout of 60s');
    const result = resolveHeartbeatFailureError(
      new Error('aborted'),
      true,
      abortReason
    );
    
    // Must fail if error says 1200 when we configured 60
    assert.equal(result.includes('1200'), false, 'Must not contain hardcoded 1200s');
    assert.equal(result.includes('60s'), true, 'Must contain configured 60s');
  });

  it('timeout error must be exact match for configured value', () => {
    // This test fails if the error message doesn't contain the exact configured timeout
    const timeouts = [60, 90, 120, 300, 600];
    
    for (const timeoutSec of timeouts) {
      const abortReason = new Error(`Heartbeat exceeded wall-clock timeout of ${timeoutSec}s`);
      const result = resolveHeartbeatFailureError(
        new Error('aborted'),
        true,
        abortReason
      );
      
      assert.equal(
        result,
        `Heartbeat exceeded wall-clock timeout of ${timeoutSec}s`,
        `Error must contain exact configured timeout ${timeoutSec}s`
      );
    }
  });
});
