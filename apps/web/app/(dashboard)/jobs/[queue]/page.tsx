import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { QUEUE_HEARTBEAT } from '@tourbillon/shared';
import {
  getQueueJobs,
  getQueueMeta,
  JOB_STATES,
  type JobState,
} from '@/lib/jobs';
import { isJobQueueName } from '@/lib/queue';

function parseState(value: string | undefined): JobState {
  if (value && JOB_STATES.includes(value as JobState)) return value as JobState;
  return 'waiting';
}

export default async function QueueJobsPage({
  params,
  searchParams,
}: {
  params: Promise<{ queue: string }>;
  searchParams: Promise<{ state?: string }>;
}) {
  const { queue } = await params;
  const resolvedSearchParams = await searchParams;

  if (!isJobQueueName(queue)) notFound();

  if (queue === QUEUE_HEARTBEAT) {
    redirect('/jobs/heartbeat');
  }

  const meta = getQueueMeta(queue)!;
  const state = parseState(resolvedSearchParams.state);
  const { jobs, total } = await getQueueJobs(queue, state);

  return (
    <div className="p-6 space-y-6">
      <div>
        <Link href="/jobs" className="text-sm text-muted-foreground hover:text-foreground">
          ← All queues
        </Link>
        <h1 className="text-2xl font-bold tracking-tight mt-2">{meta.label}</h1>
        <p className="text-muted-foreground font-mono text-sm">{meta.name}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {JOB_STATES.map((s) => (
          <Link
            key={s}
            href={`/jobs/${queue}?state=${s}`}
            className={`inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
              state === s
                ? 'bg-primary text-primary-foreground'
                : 'border border-border hover:bg-accent'
            }`}
          >
            {s}
          </Link>
        ))}
      </div>

      <p className="text-sm text-muted-foreground">
        {total} {state} job{total === 1 ? '' : 's'}
      </p>

      <div className="border rounded-lg divide-y">
        {jobs.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">No jobs in this state.</p>
        ) : (
          jobs.map((job) => (
            <Link
              key={job.id}
              href={`/jobs/${queue}/${job.id}?state=${state}`}
              className="flex items-center justify-between gap-4 p-4 text-sm hover:bg-accent/50 transition-colors"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="font-mono text-xs truncate">{job.id}</p>
                <p className="font-medium truncate">{job.name}</p>
              </div>
              <div className="text-right text-xs text-muted-foreground shrink-0">
                <p className="capitalize">{job.state}</p>
                {job.timestamp && (
                  <p>{new Date(job.timestamp).toLocaleString()}</p>
                )}
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
