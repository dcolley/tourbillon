import { enqueueHeartbeat, type EnqueueHeartbeatResult } from '@/lib/wake-client';
import { buildRetryHeartbeatJobData } from '@/lib/retry-failed-heartbeat';
import type { HeartbeatRun } from '@tourbillon/db';

export async function triggerAgentHeartbeat(
  agentId: string,
  companyId: string
): Promise<EnqueueHeartbeatResult> {
  return enqueueHeartbeat(
    {
      agentId,
      companyId,
      invocationSource: 'on_demand',
      wakeReason: 'on_demand',
    },
    { deduplicate: false }
  );
}

/**
 * Retry a failed heartbeat run as a NEW wake (new runId, empty model context).
 * Job data is rebuilt from the failed run's contextSnapshot when possible,
 * else falls back to plain on_demand. The failed row stays immutable.
 */
export async function retryFailedHeartbeat(
  failedRun: HeartbeatRun
): Promise<EnqueueHeartbeatResult> {
  return enqueueHeartbeat(buildRetryHeartbeatJobData(failedRun), {
    deduplicate: false,
  });
}
