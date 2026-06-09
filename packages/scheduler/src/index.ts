import { createTraceLogger } from '@tourbillon/shared';
import './heartbeat-worker';
import './agent-interval-scheduler';
import './routine-scheduler';
import './approval-wake-worker';

process.on('SIGTERM', async () => { process.exit(0); });
process.on('SIGINT', async () => { process.exit(0); });

createTraceLogger('scheduler', {}).info('all workers started', {
  apiBase: process.env.INTERNAL_API_URL,
  redisUrl: process.env.REDIS_URL,
  workerConcurrency: process.env.WORKER_CONCURRENCY ?? '1',
});
