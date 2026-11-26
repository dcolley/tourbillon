export {
  resolveChatAgent,
  getOrCreateChatController,
  // TB-363 (MUST-4): persist-without-wake notice path needs the chat Agent (bridge loads it
  // through this barrel, same seam pattern as getOrCreateChatController).
  getOrCreateChatAgent,
  getChatSession,
  // S332-S5: `chatSessionId` is deliberately NOT re-exported here. Route tests replace this
  // module wholesale (see apps/web/lib/chat/session-id.ts docstring); call sites that must
  // keep working under those mocks import `@/lib/chat/session-id` directly. The barrel
  // re-export had zero consumers.
  createChatRequestContext,
  getOrCreateChatApiKey,
  chatResourceId,
  chatControllerId,
  chatContextFromTags,
  extractThreadTags,
  isReservedThreadMetadataKey,
  invalidateChatControllerForAgent,
  listCachedChatControllersForAgent,
  ChatAgentError,
  type TourbillonChatController,
  type TourbillonChatSession,
} from './registry';
