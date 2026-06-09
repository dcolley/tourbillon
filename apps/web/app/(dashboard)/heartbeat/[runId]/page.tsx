import { notFound, redirect } from 'next/navigation';
import { getHeartbeatRun, heartbeatJobHref } from '@/lib/heartbeats';

/** Legacy route — heartbeats live under /jobs/heartbeat/{jobId}. */
export default async function HeartbeatRunRedirectPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const detail = await getHeartbeatRun(runId);
  if (!detail) notFound();

  const href = heartbeatJobHref(detail.run);
  if (!href) notFound();

  redirect(href);
}
