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

/** Idle thread id for durable Agent runtime (stateless wakes with OM). */
export function buildAgentIdleThreadId(agentId: string): string {
  return `agent-durable-${agentId}`;
}

/** Idle thread id for harness (AgentController) runtime (stateless wakes with OM). */
export function buildHarnessIdleThreadId(agentId: string): string {
  return `agent-harness-${agentId}`;
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

/** Delete durable Agent idle thread before a stateless wake (Memory only). */
export async function clearAgentIdleThread(agentId: string): Promise<void> {
  await deleteThreadIfExists(buildAgentIdleThreadId(agentId));
}

/** Delete harness idle thread before a stateless wake (controller storage + Memory). */
export async function clearHarnessIdleThread(agentId: string): Promise<void> {
  const threadId = buildHarnessIdleThreadId(agentId);
  await deleteControllerThreadIfExists(threadId);
  await deleteThreadIfExists(threadId);
}

/**
 * Clear the idle thread for an agent when switching runtimes.
 * Deletes both harness and durable agent idle threads to ensure clean memory break.
 * Also cleans up legacy `agent-{agentId}` thread (pre-namespace harness idle).
 */
export async function clearIdleThreadOnRuntimeSwitch(agentId: string): Promise<void> {
  await clearHarnessIdleThread(agentId);
  await clearAgentIdleThread(agentId);
  
  // Clean up legacy harness idle thread (pre-namespace: `agent-{agentId}`).
  // Controller storage uses the new namespaced key, so only Memory cleanup needed.
  const legacyThreadId = `agent-${agentId}`;
  await deleteThreadIfExists(legacyThreadId);
}
