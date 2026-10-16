import { getMastraInstance, sweepStaleEgressSockets } from '@tourbillon/mastra';
import { createTraceLogger, isObservabilityEnabled, isPhoenixCollectorEnabled } from '@tourbillon/shared';
import { startWakeServer, startStaleSweepInterval } from './wake-server';
import { bootMastraSchedules } from './schedule-boot';
import { db } from '@tourbillon/db';
import { sql } from 'drizzle-orm';
import { runSchedulerMain, waitForDb } from './startup';
import { sweepOrphanedRunsOnStartup } from './startup-sweep';

const logger = createTraceLogger('scheduler', {});

async function main(): Promise<void> {
  const bootTime = new Date();
  // Postgres may still be starting (e.g. "the database system is not yet accepting connections").
  // Retry with backoff for ~2 min; on give-up main throws and we exit non-zero for systemd.
  const dbAttempts = await waitForDb(() => db.execute(sql`select 1`), {
    onRetry: ({ attempt, delayMs, error }) =>
      logger.info('database not ready; retrying', { attempt, delayMs, error }),
  });
  const orphanedRunsFailed = await sweepOrphanedRunsOnStartup(bootTime);
  // Defence-in-depth: unlink dead egress proxy socks left by prior crashes.
  // Live listeners are connect-probed and never removed.
  await sweepStaleEgressSockets().catch(() => undefined);
  const wakeServer = startWakeServer();
  const staleSweep = startStaleSweepInterval();
  await bootMastraSchedules();

  async function shutdown(): Promise<void> {
    clearInterval(staleSweep);
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
    observabilityEnabled: isObservabilityEnabled(),
    phoenixCollectorEnabled: isPhoenixCollectorEnabled(),
  });
}

void runSchedulerMain(main, logger);
