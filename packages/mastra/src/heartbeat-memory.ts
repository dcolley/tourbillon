import { getAgentMemory } from './agent-factory';
import { deleteControllerThreadIfExists } from './controller-config';
import { isObservationalMemoryConfigured, type CompanySettings } from '@tourbillon/shared';

export function shouldUseHeartbeatMemory(
  taskId?: string,
  companySettings?: CompanySettings | null,
): boolean {
  return Boolean(taskId) || isObservationalMemoryConfigured(companySettings);
}

export function buildInboxThreadId(companyId: string, agentId: string): string {
  return `${companyId}:${agentId}:inbox`;
}

export function buildHarnessIdleThreadId(agentId: string): string {
  return `agent-${agentId}`;
}

async function deleteThreadIfExists(threadId: string): Promise<void> {
  try {
    const memory = await getAgentMemory();
    await memory.deleteThread(threadId);
  } catch {
    // Thread may not exist — safe to ignore.
  }
}

/** Delete legacy inbox thread before a stateless wake. */
export async function clearInboxThread(companyId: string, agentId: string): Promise<void> {
  await deleteThreadIfExists(buildInboxThreadId(companyId, agentId));
}

/** Delete harness idle thread before a stateless wake (controller storage + Memory). */
export async function clearHarnessIdleThread(agentId: string): Promise<void> {
  const threadId = buildHarnessIdleThreadId(agentId);
  await deleteControllerThreadIfExists(threadId);
  await deleteThreadIfExists(threadId);
}
