/**
 * In-process cache of chat AgentControllers (one per agent, optionally per model override),
 * plus the invalidation hooks used by mutators. Dependency-free so data-layer modules
 * (agents, LLM providers, company settings) can invalidate without loading the chat runtime.
 */
const globalForChat = globalThis as unknown as {
  tourbillonChatControllers?: Map<string, Promise<unknown>>;
  /** Cache key → companyId, for company-wide invalidation. */
  tourbillonChatControllerCompanies?: Map<string, string>;
};

export function chatControllerCache<T = unknown>(): Map<string, Promise<T>> {
  if (!globalForChat.tourbillonChatControllers) {
    globalForChat.tourbillonChatControllers = new Map();
  }
  return globalForChat.tourbillonChatControllers as Map<string, Promise<T>>;
}

export function chatControllerCompanies(): Map<string, string> {
  if (!globalForChat.tourbillonChatControllerCompanies) {
    globalForChat.tourbillonChatControllerCompanies = new Map();
  }
  return globalForChat.tourbillonChatControllerCompanies;
}

/** Bust the whole in-process controller cache (HMR, process-wide config changes). */
export function clearChatControllerCache(): void {
  globalForChat.tourbillonChatControllers?.clear();
  globalForChat.tourbillonChatControllerCompanies?.clear();
}

/**
 * Invalidate all cached chat controllers for a specific agent.
 * Called after agent settings change so the next chat uses fresh config.
 */
export function invalidateChatControllerForAgent(agentId: string): void {
  const cache = chatControllerCache();
  const companies = chatControllerCompanies();
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`tourbillon-chat-${agentId}`)) {
      cache.delete(key);
      companies.delete(key);
    }
  }
}

/**
 * Invalidate every cached chat controller for a company. Called after company-level changes
 * that affect agent tools (integrations, MCP credentials / allow-list).
 */
export function invalidateChatControllersForCompany(companyId: string): void {
  const cache = chatControllerCache();
  const companies = chatControllerCompanies();
  for (const [key, owner] of [...companies.entries()]) {
    if (owner !== companyId) continue;
    cache.delete(key);
    companies.delete(key);
  }
}

/**
 * Invalidate every cached chat controller after an LLM provider registry change (default
 * provider switched, provider edited or deleted). The registry is not company-scoped, and
 * agents without their own provider resolve to the registry default, so all controllers go.
 */
export function invalidateChatControllersForProviderChange(): void {
  clearChatControllerCache();
}
