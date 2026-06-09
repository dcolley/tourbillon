import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { QUEUE_HEARTBEAT } from '@tourbillon/shared';
import {
  getJobDetail,
  getJobLiveSnapshot,
  getQueueMeta,
  JobsError,
  retryJob,
  removeJob,
  type JobState,
} from '@/lib/jobs';
import { isJobQueueName } from '@/lib/queue';
import { JobDetailLive } from './job-detail-live';

async function retryJobAction(formData: FormData) {
  'use server';

  const queue = formData.get('queue') as string;
  const jobId = formData.get('jobId') as string;
  const state = (formData.get('state') as string) || 'failed';

  if (!isJobQueueName(queue)) return;

  let error: string | null = null;
  try {
    await retryJob(queue, jobId);
  } catch (err) {
    error = err instanceof JobsError ? err.message : 'Failed to retry job.';
  }

  if (error) {
    redirect(`/jobs/${queue}/${jobId}?state=${state}&error=${encodeURIComponent(error)}`);
  }

  redirect(`/jobs/${queue}/${jobId}?state=${state}&retried=1`);
}

async function removeJobAction(formData: FormData) {
  'use server';

  const queue = formData.get('queue') as string;
  const jobId = formData.get('jobId') as string;
  const state = (formData.get('state') as string) || 'waiting';

  if (!isJobQueueName(queue)) return;

  let error: string | null = null;
  try {
    await removeJob(queue, jobId);
  } catch (err) {
    error = err instanceof JobsError ? err.message : 'Failed to remove job.';
  }

  if (error) {
    redirect(`/jobs/${queue}/${jobId}?state=${state}&error=${encodeURIComponent(error)}`);
  }

  redirect(`/jobs/${queue}?state=${state}`);
}

export default async function JobDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ queue: string; jobId: string }>;
  searchParams: Promise<{ state?: string; error?: string; retried?: string }>;
}) {
  const { queue, jobId } = await params;
  const resolvedSearchParams = await searchParams;

  if (!isJobQueueName(queue)) notFound();

  const meta = getQueueMeta(queue)!;
  const [job, liveSnapshot] = await Promise.all([
    getJobDetail(queue, jobId),
    getJobLiveSnapshot(queue, jobId),
  ]);
  if (!job || !liveSnapshot) notFound();

  const listState = (resolvedSearchParams.state as JobState) || 'waiting';
  const error = resolvedSearchParams.error ? decodeURIComponent(resolvedSearchParams.error) : null;
  const retried = resolvedSearchParams.retried === '1';

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <Link
          href={`/jobs/${queue}?state=${listState}`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back to {meta.label}
        </Link>
        <h1 className="text-2xl font-bold tracking-tight mt-2">
          {queue === QUEUE_HEARTBEAT ? 'Heartbeat' : 'Job'}
        </h1>
        <p className="font-mono text-sm text-muted-foreground mt-1 break-all">{job.id}</p>
        <p className="text-muted-foreground">{job.name}</p>
      </div>

      {retried && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Job re-queued for retry.
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <JobDetailLive
        queue={queue}
        jobId={jobId}
        listState={listState}
        initial={liveSnapshot}
        retryJobAction={retryJobAction}
        removeJobAction={removeJobAction}
      />

      {job.failedReason && (
        <JsonBlock title="Failed reason" data={job.failedReason} />
      )}

      {job.stacktrace.length > 0 && (
        <JsonBlock title="Stack trace" data={job.stacktrace.join('\n')} raw />
      )}

      <JsonBlock title="Data" data={job.data} />
      {job.returnvalue != null && <JsonBlock title="Return value" data={job.returnvalue} />}
      <JsonBlock title="Options" data={job.opts} />
    </div>
  );
}

function JsonBlock({
  title,
  data,
  raw,
}: {
  title: string;
  data: unknown;
  raw?: boolean;
}) {
  const content = raw
    ? String(data)
    : JSON.stringify(data, null, 2);

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      <pre className="border rounded-lg p-4 text-xs font-mono overflow-x-auto bg-muted/30">
        {content}
      </pre>
    </section>
  );
}
