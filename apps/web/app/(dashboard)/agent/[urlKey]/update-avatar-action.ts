'use server';

/**
 * AGENT-AVATAR-UI: save (or reset, when both fields are blank) the agent's avatar config on
 * runtimeConfig.avatar. Only the fixed shape/colour sets are accepted (parseAgentAvatarConfig).
 *
 * S297-S1: extracted verbatim from app/(dashboard)/agent/[urlKey]/page.tsx so the `!parsed`
 * reject-and-do-not-write guard can be pinned at the action level
 * (update-avatar-action.test.ts); behaviour and wording are unchanged.
 */
import { revalidatePath } from 'next/cache';
import { parseAgentAvatarConfig } from '@tourbillon/shared/agent-avatar';
import { AgentValidationError, updateAgentAvatar } from '@/lib/agents';
import { requireBoardSession } from '@/lib/company';
import { actionError, actionSuccess, type ActionResult } from '@/lib/action-result';

export async function updateAvatarConfig(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requireBoardSession();

  const agentId = formData.get('agentId') as string;
  const urlKey = formData.get('urlKey') as string;
  const shape = ((formData.get('shape') as string) ?? '').trim();
  const color = ((formData.get('color') as string) ?? '').trim();
  if (!agentId || !urlKey) return actionError('Missing agent.');

  let parsed: ReturnType<typeof parseAgentAvatarConfig> = null;
  if (shape || color) {
    parsed = parseAgentAvatarConfig({ shape, color });
    if (!parsed) return actionError('Pick a shape and a colour from the choices, or reset to default.');
  }

  try {
    await updateAgentAvatar(agentId, parsed);
  } catch (err) {
    return actionError(err instanceof AgentValidationError ? err.message : 'Failed to save avatar.');
  }

  revalidatePath(`/agent/${urlKey}`);
  return actionSuccess(parsed ? 'Avatar saved.' : 'Avatar reset to default.');
}
