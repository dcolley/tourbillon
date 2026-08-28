import { getAgentMemory } from './agent-factory';
import { deleteControllerThreadIfExists } from './controller-config';
import { isAgentObservationalMemoryConfigured, type CompanySettings, type AgentRuntimeConfig } from '@tourbillon/shared';

/**
 * Heartbeat wakes always start with empty context (no prior thread history).
 * Chat is the only long-context surface. OM may observe the current wake only.
 * 
 * @returns false - all heartbeat wakes start empty regardless of taskId or OM config
 */
export function shouldUseHeartbeatMemory(
  taskId?: string,
  companySettings?: CompanySettings | null,
  agentRuntime?: AgentRuntimeConfig | null,
): boolean {
  // Product lock: all non-chat wakes start with empty context.
  // OM may still run on the current wake, but it must not load prior wake history.
  return false;
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

/**
 * Clear all thread history before a heartbeat wake to enforce empty-context product lock.
 * Deletes idle, inbox, and issue threads so the wake starts with no prior messages.
 * OM may still run on the current wake, but it will not load prior wake transcripts.
 */
export async function clearAllHeartbeatThreads(
  companyId: string,
  agentId: string,
  taskId?: string,
): Promise<void> {
  // Clear idle threads (both durable and harness runtimes)
  await clearAgentIdleThread(agentId);
  await clearHarnessIdleThread(agentId);
  
  // Clear inbox thread (legacy stateless path)
  await clearInboxThread(companyId, agentId);
  
  // Clear issue thread if this is an assignment wake
  if (taskId) {
    const issueThreadId = `${taskId}:${agentId}`;
    await deleteThreadIfExists(issueThreadId);
  }
  
  // Clean up legacy harness idle thread (pre-namespace: `agent-{agentId}`)
  const legacyThreadId = `agent-${agentId}`;
  await deleteThreadIfExists(legacyThreadId);
}
