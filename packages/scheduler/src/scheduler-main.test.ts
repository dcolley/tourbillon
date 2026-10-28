/**
 * S1 + S2 (#202 ACCEPT softs): the scheduler BOOT path around the startup Run Task reconcile.
 *
 * B1 from #202 held that a reconcile fault must never block boot: main() carries a `.catch`
 * that logs and continues with zeroed counts. Today nothing fails if that `.catch` is deleted
 * — so this test injects a rejecting reconcile and asserts (a) main() still RESOLVES, (b) the
 * wake server / stale sweep / schedules / task poller all start anyway, and (c) the failure is
 * logged via logger.ERROR (S2: the level was logger.info, which buried a failed subsystem in
 * routine startup noise). Deleting the `.catch` makes main() reject → test fails; reverting
 * the level makes logger.error see nothing → test fails.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { createRequire } from 'node:module';
import type { Logger } from './startup';
// Type-only import is erased at runtime — it does NOT trigger the module load.
import type { SchedulerBootDeps } from './scheduler-main';

// scheduler-main imports @tourbillon/db at module load, which validates DATABASE_URL eagerly.
process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused';

// scheduler-main → wake-server → wake-runner → redis-pub eagerly creates a real ioredis
// client at module load (`export const redisPub = createConnection()`). Nothing in these
// tests publishes (every boot side-effect is faked), but that client would reconnect against
// 127.0.0.1:6379 forever and keep the test process alive after the assertions settle. Seed
// './redis' with a stub in the require cache BEFORE the dynamic import of scheduler-main:
// the whole rest of the graph loads for real, while no socket is ever opened. (The
// node:test mock.module route needs --experimental-test-module-mocks on the repo's Node 20+
// test matrix, so the cache stub is the portable form here.)
const fakeRedisClient = {
  publish: async () => 0,
  quit: async () => 'OK' as const,
  disconnect: () => undefined,
  on: () => fakeRedisClient,
};
{
  const require_ = createRequire(import.meta.url);
  const redisPath = require_.resolve('./redis');
  const stub = {
    id: redisPath,
    filename: redisPath,
    loaded: true,
    exports: { createConnection: () => fakeRedisClient, connection: fakeRedisClient },
    children: [],
    paths: [],
  } as unknown as NodeJS.Require['cache'][string];
  require_.cache[redisPath] = stub;
}

let main!: (logger: Logger, boot: SchedulerBootDeps) => Promise<void>;

interface LoggedLine {
  level: 'info' | 'error';
  msg: string;
  data?: Record<string, unknown>;
}

function fakeLogger() {
  const lines: LoggedLine[] = [];
  return {
    lines,
    logger: {
      info: (msg: string, data?: Record<string, unknown>) => lines.push({ level: 'info', msg, data }),
      error: (msg: string, data?: Record<string, unknown>) => lines.push({ level: 'error', msg, data }),
    },
  };
}

interface BootFakes {
  deps: SchedulerBootDeps;
  calls: Record<string, number>;
  /** Lets an override count like the default it replaces (see the rejecting-reconcile test). */
  count: (name: string) => void;
}

function bootFakes(over: Partial<SchedulerBootDeps> = {}): BootFakes {
  const calls: Record<string, number> = {};
  const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const deps: SchedulerBootDeps = {
    // DB gate passes instantly; the probe must never actually reach a driver.
    waitForDb: async () => 1,
    probeDatabase: (async () => undefined) as SchedulerBootDeps['probeDatabase'],
    sweepOrphanedRunsOnStartup: async () => {
      count('orphanSweep');
      return 3;
    },
    reconcileChatTaskRunsOnStartup: async () => {
      // counted by the wrapper below
      return { requeued: 2, parked: 1, reconciled: [] };
    },
    sweepStaleEgressSockets: async () => {
      count('egressSweep');
    },
    startWakeServer: () => {
      count('wakeServer');
      return { close: (cb?: () => void) => cb?.() };
    },
    startStaleSweepInterval: () => {
      count('staleSweep');
      const timer = setInterval(() => undefined, 60_000);
      timer.unref();
      return timer;
    },
    bootMastraSchedules: async () => {
      count('schedules');
    },
    startTaskRunnerPolling: () => {
      count('taskPoller');
      return { stop: () => undefined };
    },
    ...over,
  };
  // Count AFTER the overrides so a test replacing reconcile still sees its call counted
  // (the rejecting-reconcile test would otherwise assert against an uncounted override).
  const baseReconcile = deps.reconcileChatTaskRunsOnStartup;
  deps.reconcileChatTaskRunsOnStartup = async (bootTime) => {
    count('reconcile');
    return baseReconcile(bootTime);
  };
  return { deps, calls, count };
}

const RECONCILE_FAIL_MSG = 'startup Run Task reconcile failed';

describe('scheduler boot: startup Run Task reconcile failure is logged and boot continues (S1+S2, #202 softs)', () => {
  before(async () => {
    // Imported AFTER the './redis' require-cache stub above — the real module graph loads,
    // but no ioredis socket is ever opened (createConnection comes from the stub).
    main = (await import('./scheduler-main')).main;
  });

  it('a rejecting reconcile logs via logger.error and boot STILL completes (wake server, sweep, schedules, poller)', async () => {
    const { logger, lines } = fakeLogger();
    const { deps, calls } = bootFakes({
      reconcileChatTaskRunsOnStartup: async () => {
        throw new Error('reconcile exploded');
      },
    });

    // This is the `.catch` under test: without it main() rejects and this await throws.
    await main(logger, deps);

    assert.equal(calls.reconcile, 1, 'boot ran the reconcile once');
    // S2: the fault is an ERROR, not info-level noise.
    const failures = lines.filter((l) => l.msg.includes(RECONCILE_FAIL_MSG));
    assert.equal(failures.length, 1, 'exactly one reconcile-failure line');
    assert.equal(failures[0]!.level, 'error', 'S2: reconcile failure must go through logger.error');
    assert.equal(failures[0]!.data?.error, 'reconcile exploded');
    assert.equal(
      lines.filter((l) => l.level === 'info' && l.msg.includes(RECONCILE_FAIL_MSG)).length,
      0,
      'the failure must not be logged at info level',
    );
    // B1 contract: the fault never blocks boot — every later stage still runs.
    assert.equal(calls.orphanSweep, 1);
    assert.equal(calls.wakeServer, 1);
    assert.equal(calls.staleSweep, 1);
    assert.equal(calls.schedules, 1);
    assert.equal(calls.taskPoller, 1);
    const ready = lines.find((l) => l.msg === 'scheduler ready');
    assert.ok(ready, 'boot reached the ready line');
    assert.equal(ready!.data?.orphanedRunsFailed, 3, 'the orphan sweep landed despite the reconcile fault');
    assert.equal(ready!.data?.taskRunsRequeued, 0, 'failed reconcile reports zeroed counts');
    assert.equal(ready!.data?.taskRunsParked, 0);
  });

  it('happy path: reconcile counts flow into the ready line and nothing is logged as an error', async () => {
    const { logger, lines } = fakeLogger();
    const { deps, calls } = bootFakes();
    await main(logger, deps);
    assert.equal(lines.filter((l) => l.level === 'error').length, 0);
    const ready = lines.find((l) => l.msg === 'scheduler ready');
    assert.ok(ready);
    assert.equal(ready!.data?.taskRunsRequeued, 2);
    assert.equal(ready!.data?.taskRunsParked, 1);
    assert.equal(calls.taskPoller, 1);
  });
});
