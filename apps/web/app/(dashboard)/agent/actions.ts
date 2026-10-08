'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  AgentValidationError,
  deleteAgent,
  setAgentActive,
  updateAgentRole,
} from '@/lib/agents';
import { triggerAgentHeartbeat, retryFailedHeartbeat } from '@/lib/heartbeat';
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

  let queueError: string | null = null;
  let result: Awaited<ReturnType<typeof triggerAgentHeartbeat>> | undefined;
  try {
    result = await triggerAgentHeartbeat(agentId, companyId);
  } catch (err) {
    queueError = err instanceof Error ? err.message : 'Failed to queue heartbeat.';
  }

  if (queueError) {
    redirect(`${errorBase}?error=${encodeURIComponent(queueError)}`);
  }

  if (!result?.jobId) {
    const message =
      result?.outcome === 'skipped'
        ? (result.skipReason ?? 'Agent cannot be woken right now.')
        : 'Heartbeat was not queued — a wake may already be in flight for this agent.';
    redirect(`${errorBase}?error=${encodeURIComponent(message)}`);
  }

  redirect(`/heartbeat/${result.jobId}`);
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

  const schedulerUrl = process.env.SCHEDULER_WAKE_URL ?? 'http://127.0.0.1:3003';
  const apiKey = process.env.SCHEDULER_API_KEY;

  if (!apiKey) {
    redirect(`${returnPath}?error=${encodeURIComponent('SCHEDULER_API_KEY not configured')}`);
  }

  let errorMessage: string | null = null;

  try {
    const response = await fetch(`${schedulerUrl}/internal/force-kill/${runId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ companyId }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      errorMessage = error.error ?? 'Failed to force-kill heartbeat';
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : 'Failed to force-kill heartbeat';
  }

  revalidatePath(returnPath);
  
  if (errorMessage) {
    redirect(`${returnPath}?error=${encodeURIComponent(errorMessage)}`);
  }
  
  redirect(`${returnPath}?killed=1`);
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

  let queueError: string | null = null;
  let result: Awaited<ReturnType<typeof retryFailedHeartbeat>> | undefined;
  try {
    result = await retryFailedHeartbeat(detail.run);
  } catch (err) {
    queueError = err instanceof Error ? err.message : 'Failed to queue retry heartbeat.';
  }

  if (queueError) {
    redirect(`${returnPath}?error=${encodeURIComponent(queueError)}`);
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
