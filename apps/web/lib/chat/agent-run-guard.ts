import type { Agent } from '@tourbillon/db';
import { ChatAgentError } from './errors';

/**
 * Chat turns run the agent and its tools, so archived or pending-approval agents cannot chat
 * (409). Reading existing threads stays available. Paused agents can still chat.
 */
export function assertChatAgentCanRun(agentRecord: Pick<Agent, 'status'>): void {
  if (agentRecord.status === 'archived') {
    throw new ChatAgentError('Agent is archived and cannot chat.', 409);
  }
  if (agentRecord.status === 'pending_approval') {
    throw new ChatAgentError('Agent is pending approval and cannot chat yet.', 409);
  }
}
