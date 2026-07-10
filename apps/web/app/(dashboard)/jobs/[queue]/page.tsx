import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { isJobQueueName } from '@/lib/queue';
import { getQueueMeta } from '@/lib/jobs';

export default async function QueueJobsPage({
  params,
}: {
  params: Promise<{ queue: string }>;
  searchParams: Promise<{ state?: string }>;
}) {
  const { queue } = await params;

  if (!isJobQueueName(queue)) notFound();
  redirect('/jobs/heartbeat');

  // unreachable — satisfy types
  const meta = getQueueMeta(queue);
  return (
    <div className="p-6">
      <Link href="/jobs">← All queues</Link>
      <h1>{meta?.label}</h1>
    </div>
  );
}
