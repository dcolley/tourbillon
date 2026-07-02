import { createTraceLogger, isObservabilityEnabled } from '@tourbillon/shared';
import { startReconciler } from './heartbeat-run-reconciler';

async function main(): Promise<void> {
  await startReconciler();

  const [{ heartbeatWorker }, { approvalWakeWorker }, { heartbeatQueue }] = await Promise.all([
    import('./heartbeat-worker'),
    import('./approval-wake-worker'),
    import('./heartbeat-queue'),
  ]);
  await import('./agent-interval-scheduler');
  await import('./routine-scheduler');

  async function shutdown(): Promise<void> {
    await heartbeatWorker.close();
    await approvalWakeWorker.close();
    await heartbeatQueue.close();
    process.exit(0);
  }

  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });

  createTraceLogger('scheduler', {}).info('all workers started', {
    apiBase: process.env.INTERNAL_API_URL,
    redisUrl: process.env.REDIS_URL,
    workerConcurrency: process.env.WORKER_CONCURRENCY ?? '1',
    observabilityEnabled: isObservabilityEnabled(),
  });
}

void main().catch((err) => {
  createTraceLogger('scheduler', {}).error('failed to start', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
