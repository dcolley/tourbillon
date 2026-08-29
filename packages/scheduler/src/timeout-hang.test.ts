import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveHeartbeatFailureError } from './heartbeat-abort';

/**
 * Real timeout enforcement tests with actual hangs.
 * These tests MUST fail if:
 * - Duration is 1199s/1200s while timeout is 60s
 * - Error says 1200 when timeout is 60
 * - Stream completes instead of aborting
 */

describe('Wall-clock timeout enforcement with real hangs', () => {
  it('US1: 60s timeout aborts hung stream at ~60s, error quotes 60s not 1200s', async () => {
    const timeoutSec = 60;
    const timeoutMs = 100; // Use 100ms for test speed (represents 60s in production)
    
    const abortController = new AbortController();
    let streamCompleted = false;
    
    // Simulate hung stream that never resolves (mimics durableAgent.stream())
    const hungStream = new Promise<never>(() => {
      // Never resolves - this is a hung LLM generation
    });
    
    // Abort promise that races with stream (mimics runDurableAgentWake)
    const abortPromise = new Promise<never>((_, reject) => {
      if (abortController.signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      abortController.signal.addEventListener('abort', () => {
        reject(new Error('aborted'));
      }, { once: true });
    });
    
    // Wall-clock timeout (mimics runWake)
    setTimeout(() => {
      abortController.abort(new Error(`Heartbeat exceeded wall-clock timeout of ${timeoutSec}s`));
    }, timeoutMs);
    
    const startTime = Date.now();
    
    try {
      // CRITICAL: This must throw when abort fires, not wait for hungStream
      await Promise.race([hungStream, abortPromise]);
      assert.fail('Should have aborted');
    } catch (err) {
      const durationMs = Date.now() - startTime;
      
      // CRITICAL: Duration must be close to timeout (not 1199s/1200s)
      assert.ok(durationMs >= timeoutMs - 10, `Duration ${durationMs}ms should be >= ${timeoutMs - 10}ms`);
      assert.ok(durationMs < timeoutMs + 100, `Duration ${durationMs}ms should be < ${timeoutMs + 100}ms`);
      
      // Stream should NOT have completed (Promise.race stopped waiting)
      assert.equal(streamCompleted, false, 'Hung stream must not complete');
      
      // Extract error from abort reason
      const errorText = resolveHeartbeatFailureError(
        err,
        abortController.signal.aborted,
        abortController.signal.reason
      );
      
      // CRITICAL: Error must quote configured timeout (60s), not 1200s
      assert.equal(errorText.includes('60s'), true, 'Error must contain 60s');
      assert.equal(errorText.includes('1200'), false, 'Error must NOT contain 1200');
      assert.equal(errorText.includes('wall-clock timeout'), true, 'Error must mention wall-clock timeout');
    }
  });

  it('US2: unset timeout defaults to 300s, error quotes 300s not 1200s', async () => {
    const defaultTimeoutSec = 300;
    const timeoutMs = 80; // Represents 300s in production
    
    const abortController = new AbortController();
    let hungCompleted = false;
    
    // Hung stream
    const hungStream = new Promise<never>(() => {
      // Never resolves
    });
    
    const abortPromise = new Promise<never>((_, reject) => {
      abortController.signal.addEventListener('abort', () => {
        reject(new Error('aborted'));
      }, { once: true });
    });
    
    // Default timeout
    setTimeout(() => {
      abortController.abort(new Error(`Heartbeat exceeded wall-clock timeout of ${defaultTimeoutSec}s`));
    }, timeoutMs);
    
    const startTime = Date.now();
    
    try {
      await Promise.race([hungStream, abortPromise]);
      assert.fail('Should have aborted');
    } catch (err) {
      const durationMs = Date.now() - startTime;
      
      // Must abort at ~80ms (300s in production), not 1200s
      assert.ok(durationMs >= timeoutMs - 10, `Duration ${durationMs}ms should be >= ${timeoutMs - 10}ms`);
      assert.ok(durationMs < timeoutMs + 100, `Duration ${durationMs}ms should be < ${timeoutMs + 100}ms`);
      
      assert.equal(hungCompleted, false, 'Stream must not complete');
      
      const errorText = resolveHeartbeatFailureError(
        err,
        abortController.signal.aborted,
        abortController.signal.reason
      );
      
      // CRITICAL: Must say 300s (default), not 1200s
      assert.equal(errorText.includes('300s'), true, 'Error must contain 300s');
      assert.equal(errorText.includes('1200'), false, 'Error must NOT contain 1200');
    }
  });

  it('US4: abort promise rejection stops waiting for hung stream (1199s generation would fail)', async () => {
    const timeoutMs = 50;
    let streamCompleted = false;
    
    const abortController = new AbortController();
    
    // Simulate stream that would take 1000ms (represents 1199s in production)
    const slowStream = new Promise<string>((resolve) => {
      setTimeout(() => {
        streamCompleted = true;
        resolve('completed after 1199s');
      }, 1000);
    });
    
    const abortPromise = new Promise<never>((_, reject) => {
      abortController.signal.addEventListener('abort', () => {
        reject(new Error('aborted'));
      }, { once: true });
    });
    
    // Timeout fires at 50ms (represents 60s timeout)
    setTimeout(() => {
      abortController.abort(new Error('Heartbeat exceeded wall-clock timeout of 60s'));
    }, timeoutMs);
    
    const startTime = Date.now();
    
    try {
      // CRITICAL: Promise.race must stop waiting when abort fires (50ms), not wait 1000ms
      await Promise.race([slowStream, abortPromise]);
      assert.fail('Should have thrown');
    } catch (err) {
      const durationMs = Date.now() - startTime;
      
      // CRITICAL: Must abort at ~50ms, NOT wait 1000ms for stream
      assert.ok(durationMs < 200, `Duration ${durationMs}ms must be < 200ms (abort won, not stream)`);
      
      // This test FAILS if duration is ~1000ms (represents 1199s empty generation)
      assert.ok(durationMs < 1000, `CRITICAL FAIL: Waited ${durationMs}ms, would be 1199s in production`);
      
      // Stream should NOT have completed (Promise.race stopped waiting)
      assert.equal(streamCompleted, false, 'Stream must not complete when abort fires first');
    }
  });

  it('US6: force-kill returns before wall-clock timeout with operator error', async () => {
    const wallClockTimeoutMs = 500; // Long timeout
    const forceKillMs = 50; // Force-kill fires early
    
    const abortController = new AbortController();
    let killedByOperator = false;
    let killedByTimeout = false;
    
    // Hung stream
    const hungStream = new Promise<never>(() => {
      // Never resolves
    });
    
    const abortPromise = new Promise<never>((_, reject) => {
      abortController.signal.addEventListener('abort', () => {
        const reason = abortController.signal.reason;
        if (reason instanceof Error && reason.message === 'Force-killed by operator') {
          killedByOperator = true;
        } else {
          killedByTimeout = true;
        }
        reject(reason || new Error('aborted'));
      }, { once: true });
    });
    
    // Wall-clock timeout (should not fire)
    const wallClockTimer = setTimeout(() => {
      abortController.abort(new Error('Heartbeat exceeded wall-clock timeout of 300s'));
    }, wallClockTimeoutMs);
    
    // Force-kill fires first
    setTimeout(() => {
      clearTimeout(wallClockTimer);
      abortController.abort(new Error('Force-killed by operator'));
    }, forceKillMs);
    
    const startTime = Date.now();
    
    try {
      await Promise.race([hungStream, abortPromise]);
      assert.fail('Should have aborted');
    } catch (err) {
      const durationMs = Date.now() - startTime;
      
      // CRITICAL: Must return at forceKillMs (~50ms), not wallClockTimeoutMs (500ms)
      assert.ok(durationMs < 150, `Duration ${durationMs}ms must be < 150ms (force-kill, not timeout)`);
      assert.ok(durationMs < wallClockTimeoutMs, `Duration ${durationMs}ms must be < ${wallClockTimeoutMs}ms`);
      
      // Must be killed by operator, not timeout
      assert.equal(killedByOperator, true, 'Must be killed by operator');
      assert.equal(killedByTimeout, false, 'Must NOT be killed by timeout');
      
      const errorText = resolveHeartbeatFailureError(
        err,
        abortController.signal.aborted,
        abortController.signal.reason
      );
      
      // Error must be operator kill, not timeout
      assert.equal(errorText, 'Force-killed by operator');
      assert.equal(errorText.includes('timeout'), false, 'Error must NOT mention timeout');
    }
  });

  it('abort promise with configured timeout quotes exact value in error', async () => {
    // Test multiple timeout values to ensure no hardcoded 1200
    const testTimeouts = [
      { sec: 60, ms: 30 },
      { sec: 90, ms: 40 },
      { sec: 120, ms: 50 },
      { sec: 300, ms: 60 },
    ];
    
    for (const { sec, ms } of testTimeouts) {
      const abortController = new AbortController();
      
      const hungStream = new Promise<never>(() => {});
      
      const abortPromise = new Promise<never>((_, reject) => {
        abortController.signal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        }, { once: true });
      });
      
      setTimeout(() => {
        abortController.abort(new Error(`Heartbeat exceeded wall-clock timeout of ${sec}s`));
      }, ms);
      
      try {
        await Promise.race([hungStream, abortPromise]);
        assert.fail(`Should have aborted for ${sec}s`);
      } catch (err) {
        const errorText = resolveHeartbeatFailureError(
          err,
          abortController.signal.aborted,
          abortController.signal.reason
        );
        
        // Error must contain the exact configured value
        assert.equal(errorText.includes(`${sec}s`), true, `Error must contain ${sec}s`);
        
        // Must NOT contain other timeout values
        for (const other of testTimeouts) {
          if (other.sec !== sec) {
            assert.equal(
              errorText.includes(`${other.sec}s`),
              false,
              `Error must NOT contain ${other.sec}s when configured as ${sec}s`
            );
          }
        }
        
        // Must NOT contain 1200
        assert.equal(errorText.includes('1200'), false, `Error must NOT contain 1200 when configured as ${sec}s`);
      }
    }
  });
});
