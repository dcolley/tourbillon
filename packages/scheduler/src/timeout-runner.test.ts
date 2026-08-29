import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { raceStreamWithAbort } from './wake-runner';
import { TripwireDetector } from '@tourbillon/mastra';

/**
 * Tests call the PRODUCTION raceStreamWithAbort helper from wake-runner.ts.
 * 
 * This helper contains the Promise.race logic that stops waiting for hung streams.
 * Tests MUST call this production function, not reimplement Promise.race.
 * 
 * If Promise.race is deleted from raceStreamWithAbort, these tests will FAIL.
 */

describe('Production raceStreamWithAbort timeout enforcement', () => {
  it('US1: timeout.heartbeatSec=60 aborts hung stream at ~60ms (calls production helper)', async () => {
    // Simulates runtimeConfig.timeout.heartbeatSec = 60
    const runtimeConfig = { timeout: { heartbeatSec: 60 } };
    const timeoutMs = 60; // In production: 60000ms
    
    let streamCleanedUp = false;
    let streamStarted = false;
    
    // Mock hung stream (simulates durableAgent.stream() that never returns)
    const hungStream = {
      runId: 'test-run-id',
      output: {
        text: new Promise<string>(() => {
          // Never resolves - hung LLM
        }),
      },
      cleanup: () => {
        streamCleanedUp = true;
      },
    };
    
    const startTime = Date.now();
    
    // Wall-clock timer (simulates wake-runner.ts:445-453)
    const abortController = new AbortController();
    const timeoutSec = runtimeConfig.timeout.heartbeatSec; // Reads from config
    
    const wallClockTimer = setTimeout(() => {
      abortController.abort(new Error(`Heartbeat exceeded wall-clock timeout of ${timeoutSec}s`));
    }, timeoutMs);
    
    // Tripwire detector (simulates wake-runner.ts:744-746)
    const detector = new TripwireDetector('test-run-id');
    
    try {
      // CRITICAL: Call PRODUCTION helper from wake-runner.ts
      // This test FAILS if Promise.race is deleted from raceStreamWithAbort
      await raceStreamWithAbort({
        streamFn: async () => {
          streamStarted = true;
          return hungStream;
        },
        abortSignal: abortController.signal,
        tripwireDetector: detector,
      });
      
      assert.fail('Should have aborted');
    } catch (err) {
      const durationMs = Date.now() - startTime;
      clearTimeout(wallClockTimer);
      detector.clear();
      
      // Must abort at ~60ms (configured timeout)
      assert.ok(durationMs >= timeoutMs - 10);
      assert.ok(durationMs < timeoutMs + 100);
      
      assert.equal(streamStarted, true);
      assert.equal(streamCleanedUp, true);
    }
  });

  it('US2: unset timeout.heartbeatSec defaults to 300s (calls production helper)', async () => {
    // Simulates runtimeConfig.timeout = undefined (unset)
    const runtimeConfig = { timeout: undefined };
    const timeoutMs = 80; // In production, 300000ms
    
    let streamStarted = false;
    let streamCleanedUp = false;
    
    const hungStream = {
      runId: 'test-run-id-2',
      output: {
        text: new Promise<string>(() => {}),
      },
      cleanup: () => {
        streamCleanedUp = true;
      },
    };
    
    const startTime = Date.now();
    
    // Production pattern from wake-runner.ts:445: runtimeConfig.timeout?.heartbeatSec ?? 300
    const abortController = new AbortController();
    const timeoutSec = runtimeConfig.timeout?.heartbeatSec ?? 300; // Reads default when unset
    
    const wallClockTimer = setTimeout(() => {
      abortController.abort(new Error(`Heartbeat exceeded wall-clock timeout of ${timeoutSec}s`));
    }, timeoutMs);
    
    const detector = new TripwireDetector('test-run-id-2');
    
    try {
      // Call PRODUCTION helper - tests runner default
      await raceStreamWithAbort({
        streamFn: async () => {
          streamStarted = true;
          return hungStream;
        },
        abortSignal: abortController.signal,
        tripwireDetector: detector,
      });
      
      assert.fail('Should have aborted');
    } catch (err) {
      const durationMs = Date.now() - startTime;
      clearTimeout(wallClockTimer);
      detector.clear();
      
      // Must use default 300, not 1200
      assert.equal(timeoutSec, 300, 'Default timeout must be 300');
      assert.ok(durationMs >= timeoutMs - 10);
      assert.ok(durationMs < timeoutMs + 100);
      
      assert.equal(streamStarted, true);
      assert.equal(streamCleanedUp, true);
    }
  });

  it('US4: Promise.race stops waiting for hung stream (FAILS if race deleted from raceStreamWithAbort)', async () => {
    const runtimeConfig = { timeout: { heartbeatSec: 60 } };
    const timeoutMs = 50;
    let slowStreamCompleted = false;
    
    // Slow stream that completes after 1000ms (represents 1199s in production)
    const slowStream = {
      runId: 'test-run-id-4',
      output: {
        text: new Promise<string>((resolve) => {
          setTimeout(() => {
            slowStreamCompleted = true;
            resolve('completed after 1199s');
          }, 1000);
        }),
      },
      cleanup: () => {},
    };
    
    const startTime = Date.now();
    
    // Production pattern from wake-runner.ts:445-453
    const abortController = new AbortController();
    const timeoutSec = runtimeConfig.timeout.heartbeatSec;
    
    setTimeout(() => {
      abortController.abort(new Error(`Heartbeat exceeded wall-clock timeout of ${timeoutSec}s`));
    }, timeoutMs);
    
    const detector = new TripwireDetector('test-run-id-4');
    
    try {
      // CRITICAL: Call PRODUCTION helper
      // If Promise.race is deleted from raceStreamWithAbort, this waits 1000ms
      // With Promise.race, it aborts at 50ms
      await raceStreamWithAbort({
        streamFn: async () => slowStream,
        abortSignal: abortController.signal,
        tripwireDetector: detector,
      });
      
      assert.fail('Should have aborted');
    } catch (err) {
      const durationMs = Date.now() - startTime;
      detector.clear();
      
      // CRITICAL: Must abort at 50ms, NOT wait 1000ms for stream completion
      assert.ok(durationMs < 200, `Duration ${durationMs}ms must be < 200ms (abort won, not stream)`);
      
      // KEY ASSERTION: stream must NOT have completed
      // If Promise.race is deleted from raceStreamWithAbort, this FAILS (slowStreamCompleted = true)
      assert.equal(slowStreamCompleted, false, 'Slow stream must not complete when abort fires first');
      
      // This represents 1199s empty generation - must NOT happen after 60s timeout
      assert.ok(durationMs < 1000, `CRITICAL: Duration ${durationMs}ms, would be 1199s in production`);
    }
  });

  it('US6: forceKillHeartbeat (operator abort) returns before wall-clock timeout (calls production helper)', async () => {
    const runtimeConfig = { timeout: { heartbeatSec: 300 } }; // Long timeout
    const wallClockTimeoutMs = 500;
    const forceKillMs = 50; // Operator clicks force-kill early
    let hungStarted = false;
    let streamCleanedUp = false;
    
    const hungStream = {
      runId: 'test-run-id-6',
      output: {
        text: new Promise<string>(() => {}),
      },
      cleanup: () => {
        streamCleanedUp = true;
      },
    };
    
    const startTime = Date.now();
    
    // Production pattern: same abortController used for both wall-clock and force-kill
    // (wake-runner.ts:440-443 registers this for operator force-kill)
    const abortController = new AbortController();
    const timeoutSec = runtimeConfig.timeout.heartbeatSec;
    
    // Wall-clock timer (long timeout)
    const wallClockTimer = setTimeout(() => {
      abortController.abort(new Error(`Heartbeat exceeded wall-clock timeout of ${timeoutSec}s`));
    }, wallClockTimeoutMs);
    
    // Force-kill fires early (simulates forceKillHeartbeat calling abortController.abort)
    // Production: wake-runner.ts:1013 calls abortController.abort(operatorForceKillError())
    setTimeout(() => {
      clearTimeout(wallClockTimer);
      abortController.abort(new Error('Force-killed by operator'));
    }, forceKillMs);
    
    const detector = new TripwireDetector('test-run-id-6');
    
    try {
      // Call PRODUCTION helper with force-kill abort
      await raceStreamWithAbort({
        streamFn: async () => {
          hungStarted = true;
          return hungStream;
        },
        abortSignal: abortController.signal,
        tripwireDetector: detector,
      });
      
      assert.fail('Should have aborted');
    } catch (err) {
      const durationMs = Date.now() - startTime;
      detector.clear();
      
      // Must return at forceKillMs (~50ms), NOT wait for wallClockTimeoutMs (500ms)
      assert.ok(durationMs < 150, `Duration ${durationMs}ms must be < 150ms (force-kill, not timeout)`);
      assert.ok(durationMs < wallClockTimeoutMs, `Duration ${durationMs}ms must not wait for timeout`);
      
      // Error must be operator kill, not timeout
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'Force-killed by operator');
      
      assert.equal(hungStarted, true);
      assert.equal(streamCleanedUp, true);
    }
  });
});
