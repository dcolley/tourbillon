'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  AgentValidationError,
  deleteAgent,
  setAgentActive,
  updateAgentRole,
} from '@/lib/agents';
import { triggerAgentHeartbeat } from '@/lib/heartbeat';

export async function triggerAgentHeartbeatAction(formData: FormData) {
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

export async function updateAgentRoleAction(formData: FormData) {
  const agentId = formData.get('agentId') as string;
  const urlKey = formData.get('urlKey') as string;
  const role = formData.get('role') as string;

  if (!agentId || !urlKey) return;

  try {
    await updateAgentRole(agentId, role);
  } catch (err) {
    const message =
      err instanceof AgentValidationError ? err.message : 'Failed to update agent role.';
    redirect(`/agent/${urlKey}?error=${encodeURIComponent(message)}`);
  }

  redirect(`/agent/${urlKey}?saved=role`);
}

export async function deleteAgentAction(formData: FormData) {
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
