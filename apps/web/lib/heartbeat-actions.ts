/**
 * Redirect targets for the dashboard heartbeat actions (run heartbeat, retry, force-kill).
 *
 * A scheduler failure redirects with a fixed ?error= message. The thrown error's text never
 * reaches the URL (it can carry request detail); it is logged server-side, redacted.
 */
import { triggerAgentHeartbeat } from '@/lib/heartbeat';
import { logSchedulerError } from '@/lib/scheduler-errors';
import { requestForceKill, type ForceKillOutcome } from '@/lib/wake-client';

export const RUN_HEARTBEAT_ERROR_MESSAGE = 'Could not queue the heartbeat. Try again shortly.';
export const RETRY_HEARTBEAT_ERROR_MESSAGE = 'Could not queue the retry. Try again shortly.';
export const FORCE_KILL_ERROR_MESSAGE = 'Could not force-kill the heartbeat run. Try again shortly.';

const FORCE_KILL_REFUSALS: Record<Exclude<ForceKillOutcome, { ok: true }>['reason'], string> = {
  not_configured: 'Scheduler is not configured.',
  not_found: 'Heartbeat run not found or not running.',
  already_finished: 'Heartbeat run already finished.',
};

export function errorRedirect(path: string, message: string): string {
  return `${path}?error=${encodeURIComponent(message)}`;
}

/** Log the failure (redacted) and return the redirect with a fixed message. */
export function schedulerActionErrorRedirect(
  path: string,
  context: string,
  err: unknown,
  message: string,
): string {
  logSchedulerError(context, err);
  return errorRedirect(path, message);
}

/** Run heartbeat: /heartbeat/{runId} on success, else `errorBase?error=…` (fixed text). */
export async function runHeartbeatRedirect(
  agentId: string,
  companyId: string,
  errorBase: string,
  trigger: typeof triggerAgentHeartbeat = triggerAgentHeartbeat,
): Promise<string> {
  let result: Awaited<ReturnType<typeof triggerAgentHeartbeat>>;
  try {
    result = await trigger(agentId, companyId);
  } catch (err) {
    return schedulerActionErrorRedirect(errorBase, 'run heartbeat', err, RUN_HEARTBEAT_ERROR_MESSAGE);
  }

  if (!result?.jobId) {
    const message =
      result?.outcome === 'skipped'
        ? (result.skipReason ?? 'Agent cannot be woken right now.')
        : 'Heartbeat was not queued — a wake may already be in flight for this agent.';
    return errorRedirect(errorBase, message);
  }

  return `/heartbeat/${result.jobId}`;
}

/** Force-kill: `returnPath?killed=1` on success, else `returnPath?error=…` (fixed text). */
export async function forceKillRedirect(
  runId: string,
  companyId: string,
  returnPath: string,
  forceKill: typeof requestForceKill = requestForceKill,
): Promise<string> {
  let outcome: ForceKillOutcome;
  try {
    outcome = await forceKill(runId, companyId);
  } catch (err) {
    return schedulerActionErrorRedirect(returnPath, 'force-kill', err, FORCE_KILL_ERROR_MESSAGE);
  }
  if (!outcome.ok) {
    return errorRedirect(returnPath, FORCE_KILL_REFUSALS[outcome.reason] ?? FORCE_KILL_ERROR_MESSAGE);
  }
  return `${returnPath}?killed=1`;
}
