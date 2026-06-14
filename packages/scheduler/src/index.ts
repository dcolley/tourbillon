import { createTraceLogger, isObservabilityEnabled } from '@tourbillon/shared';
import { heartbeatWorker } from './heartbeat-worker';
import { approvalWakeWorker } from './approval-wake-worker';
import { heartbeatQueue } from './heartbeat-queue';
import './agent-interval-scheduler';
import './routine-scheduler';
import { startReconciler } from './heartbeat-run-reconciler';

startReconciler();

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
