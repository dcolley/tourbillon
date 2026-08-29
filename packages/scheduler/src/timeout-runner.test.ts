import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { enforceHeartbeatWallClock, forceKillHeartbeat } from './wake-runner';
import { TripwireDetector } from '@tourbillon/mastra';
import type { AgentRuntimeConfig } from '@tourbillon/shared';
import { db, heartbeatRuns, eq } from '@tourbillon/db';

/**
 * Tests call PRODUCTION enforceHeartbeatWallClock from wake-runner.ts.
 * 
 * This function reads timeout.heartbeatSec ?? 300 and arms the wall-clock timer.
 * Tests MUST pass real runtimeConfig, not copy setTimeout logic.
 * 
 * If the timer or `?? 300` default is deleted from enforceHeartbeatWallClock, tests FAIL.
 */

describe('Production enforceHeartbeatWallClock timeout enforcement', () => {
  it('US1: timeout.heartbeatSec=1 aborts hung stream at ~1s with error quoting 1s', async () => {
    // Real runtimeConfig with 1 second timeout (not a local timer)
    const runtimeConfig: AgentRuntimeConfig = {
      timeout: { heartbeatSec: 1 },
    };
    
    const runId = 'test-run-id-1s';
    let streamCleanedUp = false;
    let streamStarted = false;
    
    // Mock hung stream (never resolves)
    const hungStream = {
      runId,
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
    const abortController = new AbortController();
    const detector = new TripwireDetector(runId);
    
    try {
      // Call PRODUCTION helper - reads timeout.heartbeatSec from runtimeConfig
      await enforceHeartbeatWallClock({
        runId,
        runtimeConfig,
        abortController,
        streamFn: async () => {
          streamStarted = true;
          return hungStream;
        },
        tripwireDetector: detector,
      });
      
      assert.fail('Should have aborted');
    } catch (err) {
      const durationMs = Date.now() - startTime;
      detector.clear();
      
      // Must abort at ~1s (1000ms), not at a local test timer value
      assert.ok(durationMs >= 900, `Duration ${durationMs}ms must be >= 900ms`);
      assert.ok(durationMs < 1500, `Duration ${durationMs}ms must be < 1500ms`);
      
      // Error must quote the configured timeout value
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('wall-clock timeout of 1s') ||
        err.message.includes('timeout of 1s'),
        `Error must quote 1s: ${err.message}`
      );
      
      assert.equal(streamStarted, true);
      assert.equal(streamCleanedUp, true);
    }
  });

  it('US2b: unset timeout fires at 300s delay (verify default timer arm)', async () => {
    // This test verifies the timer is actually armed with 300_000ms delay
    const runtimeConfig: AgentRuntimeConfig = {};
    
    let timerDelayMs: number | undefined;
    
    // Spy on setTimeout to capture the delay
    const originalSetTimeout = global.setTimeout;
    const setTimeoutSpy = ((fn: any, delay?: number) => {
      if (delay !== undefined && delay > 100_000) {
        // This is likely the wall-clock timer (not watchdog/ping)
        timerDelayMs = delay;
      }
      return originalSetTimeout(fn, delay);
    }) as typeof setTimeout;
    
    global.setTimeout = setTimeoutSpy as any;
    
    try {
      const abortController = new AbortController();
      const detector = new TripwireDetector('test-timeout-spy');
      
      // Abort early so we don't wait 300s
      const earlyAbort = setTimeout(() => {
        abortController.abort(new Error('Test early abort'));
      }, 50);
      
      try {
        await enforceHeartbeatWallClock({
          runId: 'test-spy',
          runtimeConfig,
          abortController,
          streamFn: async () => ({
            runId: 'test-spy',
            output: { text: new Promise<string>(() => {}) },
            cleanup: () => {},
          }),
          tripwireDetector: detector,
        });
      } catch (err) {
        // Expected abort
      }
      
      clearTimeout(earlyAbort);
      detector.clear();
      
      // Verify the wall-clock timer was armed with 300_000ms (300s * 1000)
      assert.equal(timerDelayMs, 300_000, 'Unset timeout must arm timer with 300_000ms delay');
      
      // If `?? 300` is deleted from enforceHeartbeatWallClock, timerDelayMs would be NaN or 0
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  it('US4: Promise.race stops waiting for hung stream (abort before completion)', async () => {
    const runtimeConfig: AgentRuntimeConfig = {
      timeout: { heartbeatSec: 1 },
    };
    
    const runId = 'test-run-id-slow';
    let slowStreamCompleted = false;
    
    // Slow stream that completes after 5s (simulates 1199s hung generation)
    const slowStream = {
      runId,
      output: {
        text: new Promise<string>((resolve) => {
          setTimeout(() => {
            slowStreamCompleted = true;
            resolve('completed after long time');
          }, 5000);
        }),
      },
      cleanup: () => {},
    };
    
    const startTime = Date.now();
    const abortController = new AbortController();
    const detector = new TripwireDetector(runId);
    
    try {
      await enforceHeartbeatWallClock({
        runId,
        runtimeConfig,
        abortController,
        streamFn: async () => slowStream,
        tripwireDetector: detector,
      });
      
      assert.fail('Should have aborted');
    } catch (err) {
      const durationMs = Date.now() - startTime;
      detector.clear();
      
      // Must abort at ~1s, NOT wait 5s for stream completion
      assert.ok(durationMs < 2000, `Duration ${durationMs}ms must be < 2000ms (abort won, not stream)`);
      
      // Stream must NOT have completed
      assert.equal(slowStreamCompleted, false, 'Slow stream must not complete when abort fires first');
    }
  });

  it('US6: forceKillHeartbeat aborts before wall-clock timeout', async () => {
    // This tests the PRODUCTION forceKillHeartbeat function
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    
    // Insert a running heartbeat run (forceKillHeartbeat needs this)
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: 'running',
      invocationSource: 'on_demand',
      startedAt: new Date(),
    });
    
    try {
      const runtimeConfig: AgentRuntimeConfig = {
        timeout: { heartbeatSec: 300 }, // Long timeout (5 minutes)
      };
      
      let hungStreamStarted = false;
      const hungStream = {
        runId,
        output: {
          text: new Promise<string>(() => {}), // Never resolves
        },
        cleanup: () => {},
      };
      
      const abortController = new AbortController();
      const detector = new TripwireDetector(runId);
      
      // Start the hung wake - enforceHeartbeatWallClock registers the controller on the map
      const wakePromise = enforceHeartbeatWallClock({
        runId,
        runtimeConfig,
        abortController,
        streamFn: async () => {
          hungStreamStarted = true;
          return hungStream;
        },
        tripwireDetector: detector,
      });
      
      // Wait a bit for stream to start
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(hungStreamStarted, true, 'Stream must have started');
      
      const startTime = Date.now();
      
      // Call PRODUCTION forceKillHeartbeat (reads from runAbortControllers map)
      const killResult = await forceKillHeartbeat(runId, companyId);
      
      const killDurationMs = Date.now() - startTime;
      
      // forceKillHeartbeat must return immediately (not wait for 300s timeout)
      assert.ok(killDurationMs < 1000, `forceKillHeartbeat took ${killDurationMs}ms, must be < 1000ms`);
      assert.equal(killResult.success, true, 'forceKillHeartbeat must succeed');
      
      // CRITICAL: hadController must be true (enforceHeartbeatWallClock registered it)
      assert.equal(killResult.hadController, true, 'Must have found abort controller on production map');
      
      // The wake promise should reject with operator kill error (not 300s timeout)
      try {
        await wakePromise;
        assert.fail('Wake should have aborted');
      } catch (err) {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes('Force-killed') || err.message.includes('operator'),
          `Error must indicate operator kill: ${err.message}`
        );
      }
      
      detector.clear();
      
      // Verify the run was marked failed
      const updatedRun = await db.query.heartbeatRuns.findFirst({
        where: eq(heartbeatRuns.id, runId),
      });
      assert.equal(updatedRun?.status, 'failed');
    } finally {
      // Cleanup
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    }
  });
});
