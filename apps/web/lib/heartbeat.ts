import { enqueueHeartbeat, type EnqueueHeartbeatResult } from '@/lib/wake-client';

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
