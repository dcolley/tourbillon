'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { AgentValidationError, setAgentActive } from '@/lib/agents';

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
