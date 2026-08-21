/**
 * Narrow entry for dashboard chat — avoid pulling the full mastra barrel
 * (schedules, harness event writer, etc.) into the Next.js web bundle.
 */
export {
  createChatController,
  createChatAgentWithSkills,
  buildChatResourceId,
  buildChatControllerId,
  buildChatPermissionRules,
  type ChatControllerState,
  type ChatResourceContext,
} from './chat-controller';
export { createHeartbeatRuntimeContext } from './tools/api-client';
export type { AgentController, Session } from './controller-config';
