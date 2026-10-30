/**
 * S252-S1 wiring pin (#252 ACCEPT soft-pack, info/harden): the task poller is started from
 * scheduler-main with ZERO arguments — so the "pass an explicit opts.taskCap ≥ 1" half of the
 * cap-0 refusal copy (task-runner.ts) is UNREACHABLE from this entry point by construction:
 * main never supplies deps, never supplies opts, and the SchedulerBootDeps seam is typed
 * `() => { stop(): void }`, so even a future "just pass a taskCap here" edit is a deliberate
 * interface change, not a stray line. The copy-side half of the same honesty ("the remedy is
 * intentionally tool/opts-only — no wording may claim scheduler-main can pass it") is pinned
 * by task-runner-252-softs.test.ts S252-S1a/S1b. Together they pin the documented state:
 * from scheduler-main the ONLY cap-0 remedy an operator can turn is the host env
 * (TASK_RUNNER_MAX_CONCURRENT_RUNS ≥ 2).
 *
 * Mutants: wire a taskCap/opts through the boot seam here (startTaskRunnerPolling(deps, opts)
 * from main) → the zero-args assertion REDs and forces the doc/copy to be revisited with the
 * product change. Delete the call → the started assertion REDs.
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
// client at module load. Same require-cache stub as scheduler-main.test.ts (see its comment
// for why the cache stub beats mock.module on the repo's Node test matrix): the rest of the
// graph loads for real, no socket is ever opened.
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

function fakeLogger(): Logger {
  return {
    info: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
}

describe('scheduler boot: the task poller starts with no opts (S252-S1, #252 softs)', () => {
  before(async () => {
    // Imported AFTER the './redis' require-cache stub above.
    main = (await import('./scheduler-main')).main;
  });

  it('main() calls startTaskRunnerPolling with ZERO args — opts.taskCap cannot arrive from scheduler-main', async () => {
    let pollerArgs: unknown[] | undefined;
    let stops = 0;
    const boot: SchedulerBootDeps = {
      waitForDb: async () => 1,
      probeDatabase: (async () => undefined) as SchedulerBootDeps['probeDatabase'],
      sweepOrphanedRunsOnStartup: async () => 0,
      reconcileChatTaskRunsOnStartup: async () => ({ requeued: 0, parked: 0, reconciled: [] }),
      sweepStaleEgressSockets: async () => undefined,
      startWakeServer: () => ({ close: (cb?: () => void) => cb?.() }),
      startStaleSweepInterval: () => {
        const timer = setInterval(() => undefined, 60_000);
        timer.unref();
        return timer;
      },
      bootMastraSchedules: async () => undefined,
      // Rest-typed fake: assignable to the ZERO-arg seam type, and it captures whatever
      // main actually passes. The seam type is the first wall — a real wiring change must
      // also widen SchedulerBootDeps (product change), not just this call site.
      startTaskRunnerPolling: ((...args: unknown[]) => {
        pollerArgs = args;
        return {
          stop: () => {
            stops += 1;
          },
        };
      }) as SchedulerBootDeps['startTaskRunnerPolling'],
    };

    await main(fakeLogger(), boot);

    assert.ok(pollerArgs, 'boot started the task-runner poller');
    assert.equal(
      pollerArgs!.length,
      0,
      'main passes ZERO args to startTaskRunnerPolling: no deps, no opts. opts.taskCap is ' +
        'unreachable from scheduler-main by construction, so the cap-0 copy must treat the ' +
        'opts.taskCap remedy as tool/opts-only (copy side pinned by task-runner-252-softs.test.ts). ' +
        'Wiring opts through this seam is a product change and must revisit that copy + doc too.',
    );
    assert.equal(stops, 0, 'the poller is only stopped by shutdown(), which did not run here');
  });
});
