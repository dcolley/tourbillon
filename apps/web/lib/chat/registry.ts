import { db, agents, companies, type Agent } from '@tourbillon/db';
// Relative import avoids Next resolving `@tourbillon/mastra/chat` through the package
// main barrel (`index.ts`), which previously pulled harness-event-writer into the web graph.
import {
  createChatController,
  buildChatResourceId,
  buildChatControllerId,
  createHeartbeatRuntimeContext,
  type AgentController,
  type ChatControllerState,
  type ChatResourceContext,
  type Session,
} from '../../../../packages/mastra/src/chat';
import { parseCompanySettings, type AgentRuntimeConfig } from '@tourbillon/shared';
import { and, eq } from 'drizzle-orm';
import { getActiveCompany } from '@/lib/company';
import { buildChatScopedApiKey } from '@/lib/auth/chat-token';

export type TourbillonChatController = AgentController<ChatControllerState>;
export type TourbillonChatSession = Session<ChatControllerState>;

const globalForChat = globalThis as unknown as {
  tourbillonChatControllers?: Map<string, Promise<TourbillonChatController>>;
  tourbillonChatApiKeys?: Map<string, string>;
};

/** Bust in-process controller cache (HMR / workspace requirement changes). */
export function clearChatControllerCache(): void {
  globalForChat.tourbillonChatControllers?.clear();
}

/**
 * Invalidate all cached chat controllers for a specific agent.
 * Called after agent model/provider settings change so the next chat uses fresh config.
 */
export function invalidateChatControllerForAgent(agentId: string): void {
  const cache = controllerCache();
  const keysToDelete: string[] = [];
  for (const key of cache.keys()) {
    if (key.startsWith(`tourbillon-chat-${agentId}`)) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    cache.delete(key);
  }
}

function controllerCache(): Map<string, Promise<TourbillonChatController>> {
  if (!globalForChat.tourbillonChatControllers) {
    globalForChat.tourbillonChatControllers = new Map();
  }
  return globalForChat.tourbillonChatControllers;
}

// Drop cached controllers on module reload so workspace/config changes take effect in dev.
clearChatControllerCache();

function apiKeyCache(): Map<string, string> {
  if (!globalForChat.tourbillonChatApiKeys) {
    globalForChat.tourbillonChatApiKeys = new Map();
  }
  return globalForChat.tourbillonChatApiKeys;
}

export function chatResourceId(
  companyId: string,
  context: ChatResourceContext = {},
): string {
  return buildChatResourceId(companyId, context);
}

export function chatControllerCacheKey(agentId: string, modelId?: string): string {
  return buildChatControllerId(agentId, modelId);
}

export function chatControllerId(agentId: string, modelId?: string): string {
  return buildChatControllerId(agentId, modelId);
}

export function chatContextFromTags(
  tags?: Record<string, string> | null,
): ChatResourceContext {
  return {
    contextType: tags?.contextType ?? 'free',
    contextId: tags?.contextId,
  };
}

/** Resolve agent by UUID or urlKey within the active company. */
export async function resolveChatAgent(agentKey: string): Promise<Agent> {
  const company = await getActiveCompany();
  const key = agentKey.trim();
  if (!key) throw new ChatAgentError('Agent id is required', 400);

  const byId = await db.query.agents.findFirst({
    where: and(eq(agents.id, key), eq(agents.companyId, company.id)),
  });
  if (byId) return byId;

  const byUrlKey = await db.query.agents.findFirst({
    where: and(eq(agents.urlKey, key), eq(agents.companyId, company.id)),
  });
  if (byUrlKey) return byUrlKey;

  throw new ChatAgentError('Agent not found', 404);
}

export class ChatAgentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ChatAgentError';
  }
}

/**
 * Lazy per-agent (optional model override) AgentController in the Next.js process.
 * Controllers are long-lived across chat requests (not destroyed after each message).
 */
export async function getOrCreateChatController(
  agentRecord: Agent,
  opts?: { modelIdOverride?: string },
): Promise<TourbillonChatController> {
  const cache = controllerCache();
  const cacheKey = chatControllerCacheKey(agentRecord.id, opts?.modelIdOverride);
  const existing = cache.get(cacheKey);
  if (existing) return existing;

  const pending = (async () => {
    const company = await db.query.companies.findFirst({
      where: eq(companies.id, agentRecord.companyId),
    });
    const controller = await createChatController(agentRecord, {
      allowedMcpServerIds: company?.allowedMcpServerIds ?? [],
      companySettings: parseCompanySettings(company?.settings),
      modelIdOverride: opts?.modelIdOverride,
    });
    await controller.init();
    return controller;
  })();

  cache.set(cacheKey, pending);
  try {
    return await pending;
  } catch (err) {
    cache.delete(cacheKey);
    throw err;
  }
}

/** Stable chat API key for tool calls for this agent (issued once per process). */
export function getOrCreateChatApiKey(agentRecord: Agent): string {
  const cache = apiKeyCache();
  const existing = cache.get(agentRecord.id);
  if (existing) return existing;
  const chatSessionId = `chat-${agentRecord.id}`;
  const key = buildChatScopedApiKey(chatSessionId, agentRecord.id, agentRecord.companyId);
  cache.set(agentRecord.id, key);
  return key;
}

export function createChatRequestContext(agentRecord: Agent) {
  const apiKey = getOrCreateChatApiKey(agentRecord);
  return createHeartbeatRuntimeContext({
    apiKey,
    runId: `chat-${agentRecord.id}`,
    agentId: agentRecord.id,
    companyId: agentRecord.companyId,
    jobId: `chat-${agentRecord.id}`,
    agentRuntimeConfig: agentRecord.runtimeConfig as AgentRuntimeConfig,
  }) as ReturnType<typeof createHeartbeatRuntimeContext> & { get: (key: string) => unknown };
}

export async function getChatSession(
  controller: TourbillonChatController,
  agentRecord: Agent,
  opts?: {
    resourceId?: string;
    threadId?: string;
    tags?: Record<string, string>;
    scope?: string;
  },
): Promise<TourbillonChatSession> {
  const resourceId =
    opts?.resourceId ??
    chatResourceId(agentRecord.companyId, chatContextFromTags(opts?.tags));
  const requestContext = createChatRequestContext(agentRecord);
  const id = opts?.threadId ?? (opts?.scope ? `${resourceId}::${opts.scope}` : resourceId);
  return controller.createSession({
    resourceId,
    id,
    ownerId: controller.id,
    tags: opts?.tags,
    scope: opts?.scope,
    threadId: opts?.threadId,
    requestContext: requestContext as never,
  });
}

/** Reserved Mastra thread metadata keys — not used as UI/context tags. */
export function isReservedThreadMetadataKey(key: string): boolean {
  return (
    key === 'currentModelId' ||
    key === 'currentModeId' ||
    key === 'observerModelId' ||
    key === 'reflectorModelId' ||
    key === 'observationThreshold' ||
    key === 'reflectionThreshold' ||
    key === 'tokenUsage' ||
    key.startsWith('modeModelId_')
  );
}

export function extractThreadTags(metadata: unknown): Record<string, string> {
  const bag = (metadata as Record<string, unknown> | undefined) ?? {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(bag)) {
    if (typeof value === 'string' && !isReservedThreadMetadataKey(key)) {
      result[key] = value;
    }
  }
  return result;
}
