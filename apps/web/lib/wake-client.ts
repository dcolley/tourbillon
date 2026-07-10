/**
 * HTTP helpers for the web app → scheduler process (WakeRunner + schedule sync).
 */
import type { HeartbeatJobData } from '@tourbillon/shared';
import { formatTrace } from '@tourbillon/shared';
import { enrichHeartbeatJob } from './wake-payload';

function schedulerWakeBaseUrl(): string {
  return (
    process.env.SCHEDULER_WAKE_URL ??
    `http://127.0.0.1:${process.env.SCHEDULER_WAKE_PORT ?? '3003'}`
  );
}

async function schedulerFetch(path: string, body: unknown): Promise<Response> {
  return fetch(`${schedulerWakeBaseUrl()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.SCHEDULER_API_KEY ?? ''}`,
    },
    body: JSON.stringify(body),
  });
}

export type EnqueueOutcome = 'created' | 'deduplicated' | 'replaced' | 'skipped';

export interface EnqueueHeartbeatResult {
  /** heartbeat_runs.id — use for /heartbeat/{runId} redirects */
  jobId: string;
  runId: string;
  outcome: EnqueueOutcome;
  /** Set when outcome is `skipped` (paused agent, budget, inactive company, etc.). */
  skipReason?: string;
}

/** Triggers WakeRunner on the scheduler — not BullMQ. Returns real heartbeat_runs.id. */
export async function enqueueHeartbeat(
  data: HeartbeatJobData,
  _opts: { delay?: number; priority?: number; deduplicate?: boolean } = {},
): Promise<EnqueueHeartbeatResult> {
  const enriched = await enrichHeartbeatJob(data);
  if (!enriched.invocationSource) {
    enriched.invocationSource = enriched.wakeReason;
  }

  const res = await schedulerFetch('/internal/wake', enriched);
  const bodyText = await res.text();
  let json: {
    accepted?: boolean;
    agentId?: string;
    runId?: string;
    status?: string;
    error?: string;
  } = {};
  try {
    json = JSON.parse(bodyText) as typeof json;
  } catch {
    // non-JSON error body
  }

  if (!res.ok && res.status !== 202) {
    if (res.status === 409 && json.status === 'skipped') {
      console.log(
        formatTrace(
          'enqueue',
          {
            agentId: enriched.agentId,
            companyId: enriched.companyId,
            wakeReason: enriched.wakeReason,
          },
          'wake skipped by scheduler',
          { error: json.error },
        ),
      );
      return {
        jobId: '',
        runId: '',
        outcome: 'skipped',
        skipReason: json.error ?? 'wake skipped',
      };
    }
    throw new Error(
      `Wake trigger failed (${res.status}): ${json.error ?? (bodyText || 'unknown error')}`,
    );
  }

  const runId = json.runId ?? '';
  if (!runId) {
    // Coalesced behind in-flight, or skipped before creating a run row.
    if (json.status === 'queued' || res.status === 202) {
      console.log(
        formatTrace(
          'enqueue',
          {
            agentId: enriched.agentId,
            companyId: enriched.companyId,
            wakeReason: enriched.wakeReason,
          },
          'wake coalesced or deferred',
          { status: json.status, error: json.error },
        ),
      );
      return { jobId: '', runId: '', outcome: 'deduplicated' };
    }
    throw new Error(json.error ?? `Wake trigger failed: no runId (${res.status}): ${bodyText}`);
  }

  console.log(
    formatTrace(
      'enqueue',
      {
        agentId: enriched.agentId,
        agentName: enriched.agentName,
        companyId: enriched.companyId,
        taskId: enriched.taskId,
        wakeReason: enriched.wakeReason,
      },
      'wake accepted by scheduler',
      { data: enriched, accepted: json.accepted, runId },
    ),
  );

  return {
    jobId: runId,
    runId,
    outcome: 'created',
  };
}

/** Approval decide → same WakeRunner path. */
export async function enqueueApprovalWake(data: {
  approvalId: string;
  agentId: string;
  companyId: string;
  status: 'approved' | 'rejected';
  note?: string;
  linkedIssueIds?: string[];
}): Promise<void> {
  await enqueueHeartbeat(
    {
      agentId: data.agentId,
      companyId: data.companyId,
      invocationSource: 'approval_resolved',
      wakeReason: 'approval_resolved',
      approvalId: data.approvalId,
      approvalStatus: data.status,
      approvalNote: data.note,
      linkedIssueIds: data.linkedIssueIds,
      taskId: data.linkedIssueIds?.[0],
    },
    { deduplicate: false },
  );
}

/** Ask the scheduler process to upsert/pause the agent timer Mastra schedule. */
export async function requestAgentTimerScheduleSync(agentId: string): Promise<void> {
  const res = await schedulerFetch('/internal/schedules/sync-agent', { agentId });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Agent timer sync failed (${res.status}): ${body}`);
  }
}

/** Ask the scheduler process to upsert/pause/delete a routine Mastra schedule. */
export async function requestRoutineScheduleSync(
  routineId: string,
  opts: { delete?: boolean } = {},
): Promise<string | null> {
  const res = await schedulerFetch('/internal/schedules/sync-routine', {
    routineId,
    delete: opts.delete ?? false,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Routine schedule sync failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { scheduleId?: string; deleted?: boolean };
  return json.scheduleId ?? null;
}
