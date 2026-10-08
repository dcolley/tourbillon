/**
 * HTTP helpers for the web app → scheduler process (WakeRunner + schedule sync).
 */
import type { HeartbeatJobData } from '@tourbillon/shared';
import { formatTrace } from '@tourbillon/shared';
import { enrichHeartbeatJob } from './wake-payload';
import {
  SchedulerRequestError,
  WAKE_IN_FLIGHT_MESSAGE,
  logSchedulerError,
  logSchedulerResponseError,
  redactSchedulerErrorDetail,
  wakeSkipReason,
  type WakeSkipCode,
} from './scheduler-errors';

function schedulerWakeBaseUrl(): string {
  return (
    process.env.SCHEDULER_WAKE_URL ??
    `http://127.0.0.1:${process.env.SCHEDULER_WAKE_PORT ?? '3003'}`
  );
}

/**
 * POST to the scheduler. If fetch() throws (network error, or an invalid header value whose
 * text the runtime echoes into the message), log the redacted detail and throw a
 * SchedulerRequestError with a fixed message instead of the original error.
 */
async function schedulerFetch(path: string, body: unknown, context: string): Promise<Response> {
  try {
    return await fetch(`${schedulerWakeBaseUrl()}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.SCHEDULER_API_KEY ?? ''}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    logSchedulerError(context, err);
    throw new SchedulerRequestError('request_failed');
  }
}

/** Read a response body for logging; never throws. */
async function readBodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export type EnqueueOutcome = 'created' | 'deduplicated' | 'replaced' | 'skipped';

export interface EnqueueHeartbeatResult {
  /** heartbeat_runs.id — use for /heartbeat/{runId} redirects */
  jobId: string;
  runId: string;
  outcome: EnqueueOutcome;
  /**
   * Set when outcome is `skipped`: fixed client text from WAKE_SKIP_MESSAGES (paused agent,
   * budget, inactive company, …). Never the scheduler's response text.
   */
  skipReason?: string;
  /** Fixed code for skipReason. */
  skipCode?: WakeSkipCode;
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

  const res = await schedulerFetch('/internal/wake', enriched, 'wake');
  const bodyText = await readBodyText(res);
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
          { error: redactSchedulerErrorDetail(String(json.error ?? '')) },
        ),
      );
      // Scheduler skip text → fixed client enum; unknown reasons → generic "Wake skipped."
      const skip = wakeSkipReason(json.error);
      return {
        jobId: '',
        runId: '',
        outcome: 'skipped',
        skipReason: skip.message,
        skipCode: skip.code,
      };
    }
    logSchedulerResponseError('wake', res.status, bodyText || 'unknown error');
    if (typeof json.error === 'string' && json.error.includes(WAKE_IN_FLIGHT_MESSAGE)) {
      throw new SchedulerRequestError('wake_in_flight', res.status);
    }
    throw new SchedulerRequestError('bad_status', res.status);
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
          { status: json.status, error: redactSchedulerErrorDetail(String(json.error ?? '')) },
        ),
      );
      return { jobId: '', runId: '', outcome: 'deduplicated' };
    }
    logSchedulerResponseError('wake (no runId)', res.status, bodyText);
    throw new SchedulerRequestError('bad_status', res.status);
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
  const res = await schedulerFetch('/internal/schedules/sync-agent', { agentId }, 'agent timer sync');
  if (!res.ok) {
    logSchedulerResponseError('agent timer sync', res.status, await readBodyText(res));
    throw new SchedulerRequestError('bad_status', res.status);
  }
}

/** Ask the scheduler process to upsert/pause/delete a routine Mastra schedule. */
export async function requestRoutineScheduleSync(
  routineId: string,
  opts: { delete?: boolean } = {},
): Promise<string | null> {
  const res = await schedulerFetch(
    '/internal/schedules/sync-routine',
    { routineId, delete: opts.delete ?? false },
    'routine schedule sync',
  );
  if (!res.ok) {
    logSchedulerResponseError('routine schedule sync', res.status, await readBodyText(res));
    throw new SchedulerRequestError('bad_status', res.status);
  }
  const json = (await res.json()) as { scheduleId?: string; deleted?: boolean };
  return json.scheduleId ?? null;
}

export type ForceKillOutcome =
  | { ok: true }
  | { ok: false; reason: 'not_configured' | 'not_found' | 'already_finished' };

/**
 * Ask the scheduler to force-kill an in-flight heartbeat run. Known refusals map to a fixed
 * reason; anything else throws SchedulerRequestError (detail logged, redacted).
 */
export async function requestForceKill(runId: string, companyId: string): Promise<ForceKillOutcome> {
  if (!process.env.SCHEDULER_API_KEY) return { ok: false, reason: 'not_configured' };
  const res = await schedulerFetch(
    `/internal/force-kill/${encodeURIComponent(runId)}`,
    { companyId },
    'force-kill',
  );
  if (res.ok) return { ok: true };
  logSchedulerResponseError('force-kill', res.status, await readBodyText(res));
  if (res.status === 404) return { ok: false, reason: 'not_found' };
  if (res.status === 409) return { ok: false, reason: 'already_finished' };
  throw new SchedulerRequestError('bad_status', res.status);
}
