'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  AgentValidationError,
  deleteAgent,
  setAgentActive,
  updateAgentRole,
} from '@/lib/agents';
import { retryFailedHeartbeat } from '@/lib/heartbeat';
import {
  RETRY_HEARTBEAT_ERROR_MESSAGE,
  forceKillRedirect,
  runHeartbeatRedirect,
  schedulerActionErrorRedirect,
} from '@/lib/heartbeat-actions';
import { getHeartbeatRun, getInFlightHeartbeatRun } from '@/lib/heartbeats';
import { actionError, actionSuccess, type ActionResult } from '@/lib/action-result';
import { requireBoardSession } from '@/lib/company';
import type { AgentActiveToggleResult } from './[urlKey]/agent-active-chip-logic';

export async function triggerAgentHeartbeatAction(formData: FormData) {
  await requireBoardSession();
  const agentId = formData.get('agentId') as string;
  const companyId = formData.get('companyId') as string;
  const urlKey = (formData.get('urlKey') as string) || null;

  if (!agentId || !companyId) return;

  const errorBase = urlKey ? `/agent/${urlKey}` : '/agent';

  // Scheduler failures redirect with a fixed message; the detail is logged, redacted.
  redirect(await runHeartbeatRedirect(agentId, companyId, errorBase));
}

export async function toggleAgentActiveAction(formData: FormData) {
  await requireBoardSession();
  const agentId = formData.get('agentId') as string;
  const active = formData.get('active') === 'true';

  if (!agentId) return;

  try {
    await setAgentActive(agentId, active);
  } catch (err) {
    const message =
      err instanceof AgentValidationError ? err.message : 'Failed to update agent status.';
    redirect(`/agent?error=${encodeURIComponent(message)}`);
  }

  revalidatePath('/agent');
}

/**
 * UX-2: Active/Inactive status chip on the agent detail page. Same board gate
 * (requireBoardSession, #105 B1: first statement) and the same write (setAgentActive: status
 * active ↔ paused) as toggleAgentActiveAction, but returns a result instead of redirecting to
 * /agent so the chip can roll back and toast. Never touches runtimeConfig.heartbeat (the timer).
 * Archived agents cannot be activated (#119 B1, enforced in setAgentActive → 400 + toast).
 * No board session, or an agent run/chat bearer: requireBoardSession throws before any write
 * (and proxy.ts already answers such a server-action request with 401).
 */
export async function setAgentActiveAction(
  agentId: string,
  active: boolean,
  urlKey?: string,
): Promise<AgentActiveToggleResult> {
  await requireBoardSession();

  if (typeof agentId !== 'string' || !agentId.trim() || typeof active !== 'boolean') {
    return { ok: false, status: 400, error: 'Agent ID and active flag are required.' };
  }

  try {
    const updated = await setAgentActive(agentId, active);
    revalidatePath('/agent');
    if (urlKey) revalidatePath(`/agent/${urlKey}`);
    return { ok: true, active: updated.status === 'active', status: updated.status };
  } catch (err) {
    if (err instanceof AgentValidationError) {
      return { ok: false, status: 400, error: err.message };
    }
    return { ok: false, status: 500, error: 'Failed to update agent status.' };
  }
}

export async function updateAgentRoleAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  'use server';
  await requireBoardSession();

  const agentId = formData.get('agentId') as string;
  const role = formData.get('role') as string;

  if (!agentId) return actionError('Agent ID is required.');

  try {
    await updateAgentRole(agentId, role);
    return actionSuccess('Role saved. Skills, toolsets, and assigned tools reset to role defaults.');
  } catch (err) {
    const message =
      err instanceof AgentValidationError ? err.message : 'Failed to update agent role.';
    return actionError(message);
  }
}

export async function deleteAgentAction(formData: FormData) {
  await requireBoardSession();
  const agentId = formData.get('agentId') as string;
  const urlKey = formData.get('urlKey') as string;
  const confirmUrlKey = formData.get('confirmUrlKey') as string;

  if (!agentId || !urlKey) return;

  try {
    await deleteAgent(agentId, confirmUrlKey);
  } catch (err) {
    const message =
      err instanceof AgentValidationError ? err.message : 'Failed to delete agent.';
    redirect(`/agent/${urlKey}?error=${encodeURIComponent(message)}`);
  }

  revalidatePath('/agent');
  redirect('/agent?deleted=1');
}

export async function forceKillHeartbeatAction(formData: FormData) {
  await requireBoardSession();
  const runId = formData.get('runId') as string;
  const companyId = formData.get('companyId') as string;
  const returnPath = formData.get('returnPath') as string;

  if (!runId || !companyId) {
    const errorMessage = !runId ? 'Run ID is required' : 'Company ID is required';
    redirect(`${returnPath}?error=${encodeURIComponent(errorMessage)}`);
  }

  // Scheduler failures redirect with a fixed message; the detail is logged, redacted.
  const target = await forceKillRedirect(runId, companyId, returnPath);
  revalidatePath(returnPath);
  redirect(target);
}

/**
 * Retry a failed heartbeat run as a NEW wake (new runId, empty model context).
 * The failed row stays immutable. Mirrors forceKillHeartbeatAction /
 * triggerAgentHeartbeatAction for auth + redirect patterns.
 */
export async function retryFailedHeartbeatAction(formData: FormData) {
  await requireBoardSession();
  const runId = formData.get('runId') as string;
  const companyId = formData.get('companyId') as string;
  const returnPath = `/heartbeat/${runId}`;

  if (!runId || !companyId) {
    redirect('/heartbeat?error=' + encodeURIComponent('Run ID and Company ID are required'));
  }

  const detail = await getHeartbeatRun(runId);
  if (!detail || detail.run.companyId !== companyId || detail.run.status !== 'failed') {
    redirect(`${returnPath}?error=${encodeURIComponent('Heartbeat run cannot be retried.')}`);
  }

  const inFlight = await getInFlightHeartbeatRun(detail.run.agentId);
  if (inFlight) {
    redirect(
      `${returnPath}?error=${encodeURIComponent(
        `A heartbeat is already in flight for this agent (${inFlight.status}, run ${inFlight.id}).`,
      )}`,
    );
  }

  let failedTarget: string | null = null;
  let result: Awaited<ReturnType<typeof retryFailedHeartbeat>> | undefined;
  try {
    result = await retryFailedHeartbeat(detail.run);
  } catch (err) {
    failedTarget = schedulerActionErrorRedirect(
      returnPath,
      'retry heartbeat',
      err,
      RETRY_HEARTBEAT_ERROR_MESSAGE,
    );
  }

  if (failedTarget) {
    redirect(failedTarget);
  }

  if (!result?.jobId) {
    const message =
      result?.outcome === 'skipped'
        ? (result.skipReason ?? 'Retry was not queued — a wake may already be in flight for this agent.')
        : 'Retry was not queued — a wake may already be in flight for this agent.';
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }

  redirect(`/heartbeat/${result.jobId}`);
}
