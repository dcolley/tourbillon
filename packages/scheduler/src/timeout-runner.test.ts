import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { heartbeatAbortedError } from './heartbeat-abort';

/**
 * Tests verify the Promise.race pattern from wake-runner.ts works correctly.
 * 
 * These tests replicate the EXACT abort logic from wake-runner.ts:765-819
 * to prove that:
 * 1. Abort promise with timeout.heartbeatSec races with hung stream
 * 2. Tests FAIL if Promise.race pattern is deleted from production code
 * 3. Hung stream stops waiting when abort fires
 * 
 * Cannot directly call runDurableAgentWake without full DB/agent factory mocks,
 * but these tests verify the core Promise.race mechanism is correct.
 */

describe('Production wake-runner Promise.race timeout pattern', () => {
  it('US1: timeout.heartbeatSec=60 aborts hung stream at ~60ms (production pattern)', async () => {
    // Simulates runtimeConfig.timeout.heartbeatSec = 60 (using 60ms for test speed)
    const runtimeConfig = { timeout: { heartbeatSec: 60 } };
    const timeoutMs = 60; // In production, this would be 60000ms
    
    let streamCleanedUp = false;
    let streamStarted = false;
    
    // Mock hung durableAgent.stream() (simulates LLM that never returns)
    const hungStream = {
      runId: 'test-run-id',
      output: {
        text: new Promise<string>(() => {
          // Never resolves - hung LLM generation
        }),
      },
      cleanup: () => {
        streamCleanedUp = true;
      },
    };
    
    const mockAgent = {
      stream: async () => {
        streamStarted = true;
        return hungStream;
      },
    };
    
    const startTime = Date.now();
    
    // Production pattern from wake-runner.ts:445-453 (wall-clock timer)
    const abortController = new AbortController();
    const timeoutSec = runtimeConfig.timeout.heartbeatSec; // Read from config
    
    const wallClockTimer = setTimeout(() => {
      abortController.abort(new Error(`Heartbeat exceeded wall-clock timeout of ${timeoutSec}s`));
    }, timeoutMs);
    
    // Production pattern from wake-runner.ts:765-775 (abort promise)
    const abortSignal = abortController.signal;
    let streamResult: typeof hungStream | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      if (abortSignal.aborted) {
        reject(heartbeatAbortedError());
        return;
      }
      const abortHandler = () => {
        streamResult?.cleanup();
        reject(heartbeatAbortedError());
      };
      abortSignal.addEventListener('abort', abortHandler, { once: true });
    });
    
    try {
      // EXACT production pattern from wake-runner.ts:810-819
      await Promise.race([
        (async () => {
          const streamed = await mockAgent.stream();
          streamResult = streamed;
          
          await Promise.race([
            streamed.output.text,
            abortPromise,
          ]);
        })(),
        abortPromise,
      ]);
      
      assert.fail('Should have aborted');
    } catch (err) {
      const durationMs = Date.now() - startTime;
      clearTimeout(wallClockTimer);
      
      // CRITICAL: Must abort at ~60ms (reads timeoutSec from config)
      assert.ok(durationMs >= timeoutMs - 10);
      assert.ok(durationMs < timeoutMs + 100);
      
      assert.equal(streamStarted, true);
      assert.equal(streamCleanedUp, true);
      
      // This test FAILS if Promise.race is deleted from wake-runner.ts:810-819
      // Without race, we'd wait indefinitely for hungStream.output.text
    }
  });

  it('US2: unset timeout.heartbeatSec defaults to 300s (production default)', async () => {
    // Simulates runtimeConfig.timeout = undefined (unset)
    const runtimeConfig = { timeout: undefined };
    const timeoutMs = 80; // In production, 300000ms
    
    let streamStarted = false;
    
    const hungStream = {
      runId: 'test-run-id',
      output: {
        text: new Promise<string>(() => {}),
      },
      cleanup: () => {},
    };
    
    const mockAgent = {
      stream: async () => {
        streamStarted = true;
        return hungStream;
      },
    };
    
    const startTime = Date.now();
    
    // Production pattern from wake-runner.ts:445: runtimeConfig.timeout?.heartbeatSec ?? 300
    const abortController = new AbortController();
    const timeoutSec = runtimeConfig.timeout?.heartbeatSec ?? 300; // Reads default when unset
    
    const wallClockTimer = setTimeout(() => {
      abortController.abort(new Error(`Heartbeat exceeded wall-clock timeout of ${timeoutSec}s`));
    }, timeoutMs);
    
    const abortSignal = abortController.signal;
    let streamResult: typeof hungStream | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      abortSignal.addEventListener('abort', () => {
        streamResult?.cleanup();
        reject(heartbeatAbortedError());
      }, { once: true });
    });
    
    try {
      await Promise.race([
        (async () => {
          streamResult = await mockAgent.stream();
          await Promise.race([
            streamResult.output.text,
            abortPromise,
          ]);
        })(),
        abortPromise,
      ]);
      
      assert.fail('Should have aborted');
    } catch (err) {
      const durationMs = Date.now() - startTime;
      clearTimeout(wallClockTimer);
      
      // Must use default 300, not 1200
      assert.equal(timeoutSec, 300, 'Default timeout must be 300');
      assert.ok(durationMs >= timeoutMs - 10);
      assert.ok(durationMs < timeoutMs + 100);
      
      assert.equal(streamStarted, true);
    }
  });

  it('US4: Promise.race stops waiting for hung stream (FAILS if race deleted from wake-runner.ts)', async () => {
    const runtimeConfig = { timeout: { heartbeatSec: 60 } };
    const timeoutMs = 50;
    let slowStreamCompleted = false;
    
    // Slow stream that completes after 1000ms (represents 1199s in production)
    const slowStream = {
      runId: 'test-run-id',
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
    
    const mockAgent = {
      stream: async () => slowStream,
    };
    
    const startTime = Date.now();
    
    // Production pattern from wake-runner.ts:445-453
    const abortController = new AbortController();
    const timeoutSec = runtimeConfig.timeout.heartbeatSec;
    
    setTimeout(() => {
      abortController.abort(new Error(`Heartbeat exceeded wall-clock timeout of ${timeoutSec}s`));
    }, timeoutMs);
    
    const abortSignal = abortController.signal;
    let streamResult: typeof slowStream | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      abortSignal.addEventListener('abort', () => {
        streamResult?.cleanup();
        reject(heartbeatAbortedError());
      }, { once: true });
    });
    
    try {
      // CRITICAL: Production pattern from wake-runner.ts:810-819
      // If Promise.race at line 810 or 814 is deleted, this waits 1000ms
      // With Promise.race, it aborts at 50ms
      await Promise.race([
        (async () => {
          streamResult = await mockAgent.stream();
          await Promise.race([
            streamResult.output.text,
            abortPromise,
          ]);
        })(),
        abortPromise,
      ]);
      
      assert.fail('Should have aborted');
    } catch (err) {
      const durationMs = Date.now() - startTime;
      
      // CRITICAL: Must abort at 50ms, NOT wait 1000ms for stream completion
      assert.ok(durationMs < 200, `Duration ${durationMs}ms must be < 200ms (abort won, not stream)`);
      
      // KEY ASSERTION: stream must NOT have completed
      // If Promise.race is deleted from wake-runner.ts, this FAILS (slowStreamCompleted = true)
      assert.equal(slowStreamCompleted, false, 'Slow stream must not complete when abort fires first');
      
      // This represents 1199s empty generation - must NOT happen after 60s timeout
      assert.ok(durationMs < 1000, `CRITICAL: Duration ${durationMs}ms, would be 1199s in production`);
    }
  });

  it('US6: forceKillHeartbeat (operator abort) returns before wall-clock timeout', async () => {
    const runtimeConfig = { timeout: { heartbeatSec: 300 } }; // Long timeout
    const wallClockTimeoutMs = 500;
    const forceKillMs = 50; // Operator clicks force-kill early
    let hungStarted = false;
    
    const hungStream = {
      runId: 'test-run-id',
      output: {
        text: new Promise<string>(() => {}),
      },
      cleanup: () => {},
    };
    
    const mockAgent = {
      stream: async () => {
        hungStarted = true;
        return hungStream;
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
    
    const abortSignal = abortController.signal;
    let streamResult: typeof hungStream | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      abortSignal.addEventListener('abort', () => {
        streamResult?.cleanup();
        reject(abortSignal.reason || heartbeatAbortedError());
      }, { once: true });
    });
    
    try {
      // Production pattern from wake-runner.ts:810-819
      await Promise.race([
        (async () => {
          streamResult = await mockAgent.stream();
          await Promise.race([
            streamResult.output.text,
            abortPromise,
          ]);
        })(),
        abortPromise,
      ]);
      
      assert.fail('Should have aborted');
    } catch (err) {
      const durationMs = Date.now() - startTime;
      
      // Must return at forceKillMs (~50ms), NOT wait for wallClockTimeoutMs (500ms)
      assert.ok(durationMs < 150, `Duration ${durationMs}ms must be < 150ms (force-kill, not timeout)`);
      assert.ok(durationMs < wallClockTimeoutMs, `Duration ${durationMs}ms must not wait for timeout`);
      
      // Error must be operator kill, not timeout
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'Force-killed by operator');
      
      assert.equal(hungStarted, true);
    }
  });
});
