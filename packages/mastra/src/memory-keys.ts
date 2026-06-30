import { buildInboxThreadId } from './heartbeat-memory';

export interface HeartbeatMemoryKeyInput {
  companyId: string;
  agentId: string;
  issueId?: string;
  goalId?: string | null;
  projectId?: string | null;
}

export interface HeartbeatMemoryKeys {
  resource: string;
  thread: string;
}

/**
 * Build Mastra memory resource/thread keys for a heartbeat run.
 *
 * - resource: agent namespace; widened to project or goal when semantic recall is enabled
 * - thread: per-agent per-issue conversation when taskId is set; inbox thread id when not
 */
export function buildHeartbeatMemoryKeys(input: HeartbeatMemoryKeyInput): HeartbeatMemoryKeys {
  const { companyId, agentId, issueId, goalId, projectId } = input;

  let resource = `${companyId}:${agentId}`;

  if (process.env.MEMORY_SEMANTIC_RECALL === 'true') {
    if (projectId) {
      resource = `${companyId}:${agentId}:project:${projectId}`;
    } else if (goalId) {
      resource = `${companyId}:${agentId}:goal:${goalId}`;
    }
  }

  const thread = issueId ? `${issueId}:${agentId}` : buildInboxThreadId(companyId, agentId);

  return { resource, thread };
}
