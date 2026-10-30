import { getMastraInstance, sweepStaleEgressSockets } from '@tourbillon/mastra';
import { isObservabilityEnabled, isPhoenixCollectorEnabled } from '@tourbillon/shared';
import type { ChatTaskReconcileResult } from '@tourbillon/db';
import { startWakeServer, startStaleSweepInterval } from './wake-server';
import { bootMastraSchedules } from './schedule-boot';
import { startTaskRunnerPolling } from './task-runner';
import { describeDatabaseTarget, probeDatabase } from '@tourbillon/db';
import { DEFAULT_DB_ATTEMPT_TIMEOUT_MS, waitForDb, type Logger } from './startup';
import { sweepOrphanedRunsOnStartup, reconcileChatTaskRunsOnStartup } from './startup-sweep';

/**
 * S1 (#202 ACCEPT softs): the boot side-effects are injectable so the startup path — above all
 * the reconcile `.catch` — is testable without a live Postgres/Redis/Mastra. Production passes
 * nothing and gets the real wiring; a test injects fakes and asserts boot LOGS the reconcile
 * failure and CONTINUES (the B1 guarantee from #202: a reconcile fault must never block boot).
 */
export interface SchedulerBootDeps {
  waitForDb: typeof waitForDb;
  probeDatabase: typeof probeDatabase;
  sweepOrphanedRunsOnStartup: (bootTime: Date) => Promise<number>;
  reconcileChatTaskRunsOnStartup: (bootTime: Date) => Promise<ChatTaskReconcileResult>;
  sweepStaleEgressSockets: () => Promise<unknown>;
  // Structural (not http.Server) so a test fake only needs close(); the real
  // startWakeServer's http.Server satisfies it.
  startWakeServer: () => { close: (cb?: () => void) => unknown };
  startStaleSweepInterval: () => ReturnType<typeof setInterval>;
  bootMastraSchedules: () => Promise<unknown>;
  startTaskRunnerPolling: () => { stop(): void };
}

const productionBootDeps: SchedulerBootDeps = {
  waitForDb,
  probeDatabase,
  sweepOrphanedRunsOnStartup,
  reconcileChatTaskRunsOnStartup,
  sweepStaleEgressSockets,
  startWakeServer,
  startStaleSweepInterval,
  bootMastraSchedules,
  startTaskRunnerPolling,
};

export async function main(logger: Logger, boot: SchedulerBootDeps = productionBootDeps): Promise<void> {
  const bootTime = new Date();
  // Postgres may still be starting (e.g. "the database system is not yet accepting connections").
  // Retry with backoff for ~2 min; on give-up main throws and we exit non-zero for systemd.
  // Auth failures and a missing database are not retried (exit 1 at once). Each probe uses its own
  // one-connection client and is bounded by DEFAULT_DB_ATTEMPT_TIMEOUT_MS.
  const dbTarget = describeDatabaseTarget() ?? {};
  const dbAttempts = await boot.waitForDb(
    (signal) => boot.probeDatabase({ timeoutMs: DEFAULT_DB_ATTEMPT_TIMEOUT_MS, signal }),
    {
      onRetry: ({ attempt, delayMs, error, code }) =>
        logger.info('database not ready; retrying', { attempt, delayMs, error, ...(code ? { code } : {}), ...dbTarget }),
    },
  );
  const orphanedRunsFailed = await boot.sweepOrphanedRunsOnStartup(bootTime);
  // S2 (#196 follow-up): heartbeat rows are failed by the sweep above, so settle the chat_tasks
  // rows their Run Task wakes died with — otherwise they stay in_progress forever.
  // B1 (PR #202 hold): a reconcile fault must NEVER block boot — the sweep already landed and
  // the interval sweep (wake-server) retries every 30 s, so log-and-continue on failure.
  // S2 (#202 ACCEPT softs): the level is `error`, not `info` — this is a failed subsystem
  // (Run Task reconcile), only the CONTINUE decision is routine.
  const taskRunsReconciled = await boot.reconcileChatTaskRunsOnStartup(bootTime).catch((err) => {
    logger.error('startup Run Task reconcile failed; continuing boot (interval sweep retries)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { requeued: 0, parked: 0, reconciled: [] };
  });
  // Defence-in-depth: unlink dead egress proxy socks left by prior crashes.
  // Live listeners are connect-probed and never removed.
  await boot.sweepStaleEgressSockets().catch(() => undefined);
  const wakeServer = boot.startWakeServer();
  const staleSweep = boot.startStaleSweepInterval();
  await boot.bootMastraSchedules();
  // TASK-RUNNER: Run Task queue poller — gated through the shared per-agent run budget.
  // S252-S1 (#252 soft-pack): deliberately ZERO args — no deps, no opts. opts.taskCap is
  // intentionally NOT wired through this seam (the type is `() => { stop(): void }`), so from
  // scheduler-main the only cap-0 remedy an operator can turn is the host env
  // (TASK_RUNNER_MAX_CONCURRENT_RUNS ≥ 2); the opts.taskCap half of the refusal copy in
  // task-runner.ts is tool/opts-only. Pinned by scheduler-main-252-softs.test.ts.
  const taskRunner = boot.startTaskRunnerPolling();

  async function shutdown(): Promise<void> {
    clearInterval(staleSweep);
    taskRunner.stop();
    await getMastraInstance().stopWorkers();
    await new Promise<void>((resolve) => {
      wakeServer.close(() => resolve());
    });
    process.exit(0);
  }

  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });

  // One ready line. Never log URLs/connection strings (they can carry credentials).
  logger.info('scheduler ready', {
    wakePort: process.env.SCHEDULER_WAKE_PORT ?? '3003',
    dbAttempts,
    orphanedRunsFailed,
    taskRunsRequeued: taskRunsReconciled.requeued,
    taskRunsParked: taskRunsReconciled.parked,
    observabilityEnabled: isObservabilityEnabled(),
    phoenixCollectorEnabled: isPhoenixCollectorEnabled(),
  });
}
