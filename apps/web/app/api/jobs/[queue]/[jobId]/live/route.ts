import { NextResponse } from 'next/server';
import { getJobLiveSnapshot } from '@/lib/jobs';
import { isJobQueueName } from '@/lib/queue';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ queue: string; jobId: string }> },
) {
  const { queue, jobId } = await params;
  if (!isJobQueueName(queue)) {
    return NextResponse.json({ error: 'Unknown queue.' }, { status: 404 });
  }

  const snapshot = await getJobLiveSnapshot(queue, jobId);
  if (!snapshot) {
    return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
  }

  return NextResponse.json(snapshot);
}
