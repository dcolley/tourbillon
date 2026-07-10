/**
 * Wake triggers for the web app (no BullMQ heartbeats).
 * enqueueHeartbeat / enqueueApprovalWake POST to the scheduler WakeRunner.
 */
export {
  enqueueHeartbeat,
  enqueueApprovalWake,
  type EnqueueHeartbeatResult,
  type EnqueueOutcome,
} from './wake-client';

/** Path segment still used in /jobs/heartbeat URLs (DB-backed, not BullMQ). */
export type JobQueueName = 'heartbeat';

export const JOB_QUEUES: Array<{ name: JobQueueName; label: string; description: string }> = [
  {
    name: 'heartbeat',
    label: 'Heartbeat runs',
    description: 'Agent wakes tracked in heartbeat_runs (WakeRunner — no BullMQ)',
  },
];

export function isJobQueueName(name: string): name is JobQueueName {
  return name === 'heartbeat';
}

export function getQueue(_name: string): never {
  throw new Error('BullMQ heartbeat/approval queues have been removed. Use WakeRunner via enqueueHeartbeat.');
}
