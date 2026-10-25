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
export {
  ChatProviderUnavailableError,
  chatEffectiveRecord,
  chatModelOverrideKey,
  type ChatModelOverrideOptions,
} from './chat-model-override';
export { createHeartbeatRuntimeContext } from './tools/api-client';
// CTX-1: the composer context meter reads the same chat budget the controller uses.
export { resolveAgentContextBudget } from './model-settings';
export type { AgentController, Session } from './controller-config';
export {
  ASSISTANT_MESSAGE_TRACE_KEY,
  ASSISTANT_TRACE_VIEW,
  buildAssistantTracingOptions,
  isTraceId,
  messageTraceId,
  type AssistantTracingInput,
  type AssistantTracingOptions,
} from './observability/assistant-tracing';
