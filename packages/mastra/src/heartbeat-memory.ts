import { getAgentMemory } from './agent-factory';

export function shouldUseHeartbeatMemory(taskId?: string): boolean {
  return Boolean(taskId);
}

export function buildInboxThreadId(companyId: string, agentId: string): string {
  return `${companyId}:${agentId}:inbox`;
}

export function buildHarnessIdleThreadId(agentId: string): string {
  return `agent-${agentId}`;
}

async function deleteThreadIfExists(threadId: string): Promise<void> {
  try {
    await getAgentMemory().deleteThread(threadId);
  } catch {
    // Thread may not exist — safe to ignore.
  }
}

/** Delete legacy inbox thread before a stateless wake. */
export async function clearInboxThread(companyId: string, agentId: string): Promise<void> {
  await deleteThreadIfExists(buildInboxThreadId(companyId, agentId));
}

/** Delete harness idle thread before a stateless wake. */
export async function clearHarnessIdleThread(agentId: string): Promise<void> {
  await deleteThreadIfExists(buildHarnessIdleThreadId(agentId));
}
