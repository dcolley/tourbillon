import { enqueueHeartbeat } from '@/lib/queue';

export async function triggerAgentHeartbeat(
  agentId: string,
  companyId: string
): Promise<string | undefined> {
  const { jobId } = await enqueueHeartbeat(
    {
      agentId,
      companyId,
      invocationSource: 'on_demand',
      wakeReason: 'on_demand',
    },
    { deduplicate: false }
  );
  return jobId;
}
