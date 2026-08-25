import { buildInboxThreadId, buildHarnessIdleThreadId } from './heartbeat-memory';

export interface HeartbeatMemoryKeyInput {
  companyId: string;
  agentId: string;
  issueId?: string;
  goalId?: string | null;
  projectId?: string | null;
  useIdleThread?: boolean;
}

export interface HeartbeatMemoryKeys {
  resource: string;
  thread: string;
}

/**
 * Build Mastra memory resource/thread keys for a heartbeat run.
 *
 * - resource: agent namespace; widened to project or goal when semantic recall is enabled
 * - thread: per-agent per-issue conversation when taskId is set; idle thread when useIdleThread; inbox thread otherwise
 */
export function buildHeartbeatMemoryKeys(input: HeartbeatMemoryKeyInput): HeartbeatMemoryKeys {
  const { companyId, agentId, issueId, goalId, projectId, useIdleThread } = input;

  let resource = `${companyId}:${agentId}`;

  if (process.env.MEMORY_SEMANTIC_RECALL === 'true') {
    if (projectId) {
      resource = `${companyId}:${agentId}:project:${projectId}`;
    } else if (goalId) {
      resource = `${companyId}:${agentId}:goal:${goalId}`;
    }
  }

  let thread: string;
  if (issueId) {
    thread = `${issueId}:${agentId}`;
  } else if (useIdleThread) {
    thread = buildHarnessIdleThreadId(agentId);
  } else {
    thread = buildInboxThreadId(companyId, agentId);
  }

  return { resource, thread };
}
