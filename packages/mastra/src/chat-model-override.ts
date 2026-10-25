/**
 * CHAT-5: per-thread model choice for dashboard chat (pure helpers, no DB).
 *
 * A thread may pick another company-enabled provider, model and reasoning effort than the agent's
 * configured ones. The web layer checks provider enablement before asking for a controller; the
 * helpers here build the controller cache key and the record the chat model is resolved from.
 */
import type { Agent as AgentRecord } from '@tourbillon/db';
import type { ReasoningLevel } from '@tourbillon/shared';

export interface ChatModelOverrideOptions {
  /** Model id for this controller (legacy `?modelId=` override, or the thread's choice). */
  modelIdOverride?: string;
  /** Registry provider the thread picked (CHAT-5). Unset: the agent's provider. */
  providerIdOverride?: string;
  /** Reasoning effort the thread picked (CHAT-5). Unset: the agent's configured level. */
  reasoningLevelOverride?: ReasoningLevel;
}

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * Cache / controller key part for an override. A model-only override keeps the legacy key (the
 * model id), so existing `?modelId=` controllers keep their ids. Provider and effort are added
 * only when set.
 */
export function chatModelOverrideKey(options?: ChatModelOverrideOptions | null): string | undefined {
  const modelId = clean(options?.modelIdOverride);
  const providerId = clean(options?.providerIdOverride);
  const reasoning = clean(options?.reasoningLevelOverride);
  if (!providerId && !reasoning) return modelId;
  return [modelId ?? '', `provider=${providerId ?? ''}`, `effort=${reasoning ?? ''}`].join('::');
}

/** The agent record with the thread's model and provider applied (tools, skills and prompt use it). */
export function chatEffectiveRecord<T extends Pick<AgentRecord, 'modelId' | 'providerId'>>(
  agentRecord: T,
  options?: ChatModelOverrideOptions | null,
): T {
  const modelId = clean(options?.modelIdOverride);
  const providerId = clean(options?.providerIdOverride);
  const next = { ...agentRecord };
  let changed = false;
  if (modelId && modelId !== agentRecord.modelId) {
    next.modelId = modelId;
    changed = true;
  }
  if (providerId && providerId !== agentRecord.providerId) {
    next.providerId = providerId;
    changed = true;
  }
  return changed ? next : agentRecord;
}

/**
 * Fields the chat language model is resolved from. When the thread picked another provider, the
 * agent's adapter-level connection settings (provider kind, base URL, key, headers) belong to the
 * agent's own provider and are not carried over: the chosen provider's registry settings are used.
 */
export function chatModelSource(
  record: Pick<AgentRecord, 'adapterType' | 'adapterConfig' | 'modelId'>,
  options?: ChatModelOverrideOptions | null,
): Pick<AgentRecord, 'adapterType' | 'adapterConfig' | 'modelId'> {
  if (!clean(options?.providerIdOverride)) return record;
  // 'process' maps to no provider kind, and an empty config adds no connection overrides.
  return { adapterType: 'process', adapterConfig: {}, modelId: record.modelId };
}

/** Thrown when a thread's provider is not available to the company (the web layer refuses first). */
export class ChatProviderUnavailableError extends Error {
  constructor() {
    super('The provider chosen for this thread is not available to this company');
    this.name = 'ChatProviderUnavailableError';
  }
}
