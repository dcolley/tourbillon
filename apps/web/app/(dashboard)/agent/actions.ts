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
  let jobId: string | undefined;
  try {
    jobId = await triggerAgentHeartbeat(agentId, companyId);
  } catch (err) {
    queueError = err instanceof Error ? err.message : 'Failed to queue heartbeat.';
  }

  if (queueError) {
    redirect(`${errorBase}?error=${encodeURIComponent(queueError)}`);
  }

  if (!jobId) {
    redirect(
      `${errorBase}?error=${encodeURIComponent('Heartbeat was not queued — a job may already exist for this agent.')}`
    );
  }

  redirect(`/jobs/heartbeat/${jobId}?state=waiting`);
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
