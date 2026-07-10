import { notFound, redirect } from 'next/navigation';
import { isJobQueueName } from '@/lib/queue';
import { getHeartbeatRun } from '@/lib/heartbeats';

/**
 * Legacy BullMQ job URL → canonical /heartbeat/{runId}.
 * runId is heartbeat_runs.id (returned from WakeRunner after Phase 2).
 */
export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ queue: string; jobId: string }>;
}) {
  const { queue, jobId } = await params;
  if (!isJobQueueName(queue)) notFound();

  const detail = await getHeartbeatRun(jobId);
  if (!detail) notFound();

  redirect(`/heartbeat/${jobId}`);
}
