import { assertMastraToolRegistryEmpty, getMastraInstance, sweepStaleEgressSockets } from '@tourbillon/mastra';
import { createTraceLogger, isObservabilityEnabled, isPhoenixCollectorEnabled } from '@tourbillon/shared';
import { startWakeServer, startStaleSweepInterval } from './wake-server';
import { bootMastraSchedules } from './schedule-boot';

async function main(): Promise<void> {
  // Defence-in-depth: unlink dead egress proxy socks left by prior crashes.
  // Live listeners are connect-probed and never removed.
  await sweepStaleEgressSockets().catch(() => undefined);
  const wakeServer = startWakeServer();
  const staleSweep = startStaleSweepInterval();
  await bootMastraSchedules();
  // Agent tools are resolved per agent; the shared Mastra instance must never hold any.
  assertMastraToolRegistryEmpty(getMastraInstance());

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

  createTraceLogger('scheduler', {}).info('scheduler started (no BullMQ heartbeats)', {
    apiBase: process.env.INTERNAL_API_URL,
    wakePort: process.env.SCHEDULER_WAKE_PORT ?? '3003',
    redisUrl: process.env.REDIS_URL,
    observabilityEnabled: isObservabilityEnabled(),
    phoenixCollectorEnabled: isPhoenixCollectorEnabled(),
  });
}

void main().catch((err) => {
  createTraceLogger('scheduler', {}).error('failed to start', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
