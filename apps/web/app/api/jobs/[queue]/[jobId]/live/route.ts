import { NextResponse, type NextRequest } from 'next/server';
import { getJobLiveSnapshot } from '@/lib/jobs';
import { getHeartbeatRun } from '@/lib/heartbeats';
import { isJobQueueName } from '@/lib/queue';
import { requireBoardCompany } from '@/lib/board-route-auth';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ queue: string; jobId: string }> },
) {
  const { queue, jobId } = await params;

  // #106: board only; the run must belong to the board's company (other company → 404).
  const auth = await requireBoardCompany(req);
  if (!auth.ok) return auth.response;

  if (!isJobQueueName(queue)) {
    return NextResponse.json({ error: 'Unknown queue.' }, { status: 404 });
  }

  const linked = await getHeartbeatRun(jobId);
  if (!linked || linked.run.companyId !== auth.value.id) {
    return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
  }

  // jobId is the heartbeat_runs.id after Phase 2
  const snapshot = await getJobLiveSnapshot(queue, jobId);
  if (!snapshot) {
    return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
  }

  return NextResponse.json(snapshot);
}
