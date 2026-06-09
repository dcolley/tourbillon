import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import type { Agent as AgentRecord } from '@tourbillon/db';
import type { EmbeddingModelV3, LanguageModelV3 } from '@ai-sdk/provider';
import {
  modelProviderOverridesFromAgent,
  resolveModelProviderConfig,
  type ModelProviderConfig,
  type ModelProviderOverrides,
} from '@tourbillon/shared';

const providerCache = new Map<string, OpenAIProvider>();

function providerCacheKey(config: Pick<ModelProviderConfig, 'provider' | 'baseURL' | 'apiKey'>): string {
  return `${config.provider}|${config.baseURL}|${config.apiKey}`;
}

function getOpenAIProvider(config: Pick<ModelProviderConfig, 'provider' | 'baseURL' | 'apiKey'>): OpenAIProvider {
  const key = providerCacheKey(config);
  const cached = providerCache.get(key);
  if (cached) return cached;

  const provider = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    name: config.provider,
  });
  providerCache.set(key, provider);
  return provider;
}

function languageModelFromConfig(
  config: ModelProviderConfig,
  modelId?: string | null,
): LanguageModelV3 {
  const id = modelId ?? config.defaultModel;
  const provider = getOpenAIProvider(config);
  return config.apiMode === 'chat' ? provider.chat(id) : provider(id);
}

function embeddingModelFromConfig(config: ModelProviderConfig, modelId: string): EmbeddingModelV3 {
  return getOpenAIProvider(config).embedding(modelId);
}

/** @deprecated Use getLanguageModelForAgent or getLanguageModelFromEnv */
export const lmstudio = createOpenAI({
  apiKey: process.env.LM_STUDIO_API_KEY ?? 'lm-studio',
  baseURL: process.env.LM_STUDIO_BASE_URL ?? 'http://localhost:1234/v1',
  name: 'lmstudio',
});

/** Resolve config from env only (no agent overrides). */
export function getModelProviderConfigFromEnv(
  overrides?: ModelProviderOverrides | null,
  modelId?: string | null,
): ModelProviderConfig {
  return resolveModelProviderConfig(overrides, modelId);
}

/** Language model using env defaults, with optional overrides. */
export function getLanguageModelFromEnv(
  overrides?: ModelProviderOverrides | null,
  modelId?: string | null,
): LanguageModelV3 {
  const config = resolveModelProviderConfig(overrides, modelId);
  return languageModelFromConfig(config, modelId);
}

/** Language model for a specific agent (adapter type/config + modelId). */
export function getLanguageModelForAgent(
  agent: Pick<AgentRecord, 'adapterType' | 'adapterConfig' | 'modelId'>,
): LanguageModelV3 {
  const overrides = modelProviderOverridesFromAgent(agent.adapterType, agent.adapterConfig);
  const config = resolveModelProviderConfig(overrides, agent.modelId);
  return languageModelFromConfig(config, agent.modelId);
}

/** Embedding model using env provider settings. */
export function getEmbeddingModel(modelId: string): EmbeddingModelV3 {
  const config = resolveModelProviderConfig();
  return embeddingModelFromConfig(config, modelId);
}

/** @deprecated Use getLanguageModelFromEnv or getLanguageModelForAgent */
export function getModelId(overrideModelId?: string | null): string {
  return resolveModelProviderConfig(null, overrideModelId).defaultModel;
}

/** @deprecated Use getLanguageModelFromEnv or getLanguageModelForAgent */
export function getLanguageModel(overrideModelId?: string | null): LanguageModelV3 {
  return getLanguageModelFromEnv(null, overrideModelId);
}
