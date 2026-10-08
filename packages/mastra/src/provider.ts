import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import type { Agent as AgentRecord } from '@tourbillon/db';
import { getDefaultLlmProviderRow, getLlmProviderRowById } from '@tourbillon/db';

// Infer model types from the provider methods (V4 types no longer exported directly)
type LanguageModelV3 = ReturnType<OpenAIProvider['chat']>;
type EmbeddingModelV3 = ReturnType<OpenAIProvider['embedding']>;
import {
  buildProviderRequestHeaders,
  modelProviderOverridesFromAgent,
  resolveAgentModelProviderConfig,
  resolveAgentProviderRow,
  resolveModelProviderConfig,
  toLlmProviderRecord,
  type AgentProviderSource,
  type LlmProviderRecord,
  type ModelProviderConfig,
  type ModelProviderKind,
  type ModelProviderOverrides,
} from '@tourbillon/shared';
import type { LlmProvider } from '@tourbillon/db';
import { createCoalescingFetch } from './coalesce-system-messages';
import { createNousInferenceFetch } from './nous-inference-fetch';
import { createReasoningTextFetch } from './reasoning-text-fetch';
import { createFirstFrameCaptureFetch } from './first-frame-capture';
import { getCurrentHeartbeatContext } from './heartbeat-context';
import { createStickySessionFetch } from './sticky-session-fetch';

const providerCache = new Map<string, OpenAIProvider>();

function providerCacheKey(
  config: Pick<ModelProviderConfig, 'provider' | 'baseURL' | 'apiKey' | 'headers'>,
): string {
  const headerKey = JSON.stringify(
    Object.keys(config.headers)
      .sort()
      .map((k) => [k, config.headers[k]]),
  );
  return `${config.provider}|${config.baseURL}|${config.apiKey}|${headerKey}`;
}

function shouldCoalesceSystemMessages(provider: ModelProviderKind, apiMode: ModelProviderConfig['apiMode']): boolean {
  return apiMode === 'chat' && provider !== 'openai';
}

function getOpenAIProvider(
  config: Pick<ModelProviderConfig, 'provider' | 'baseURL' | 'apiKey' | 'headers' | 'apiMode' | 'stickiness' | 'stickinessHeaderName'>,
): OpenAIProvider {
  const key = `${providerCacheKey(config)}|coalesce=${shouldCoalesceSystemMessages(config.provider, config.apiMode)}|sticky=${config.stickiness ?? 'off'}:${config.stickinessHeaderName ?? ''}`;
  const cached = providerCache.get(key);
  if (cached) return cached;

  const stickyConfig =
    config.stickiness && config.stickiness !== 'off' && config.stickinessHeaderName?.trim()
      ? { stickiness: config.stickiness, headerName: config.stickinessHeaderName }
      : null;

  const provider = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    name: config.provider,
    headers: buildProviderRequestHeaders(config),
    fetch: createStickySessionFetch(
      createFirstFrameCaptureFetch(
        createReasoningTextFetch(
          createCoalescingFetch(
            createNousInferenceFetch(fetch, config.baseURL),
            shouldCoalesceSystemMessages(config.provider, config.apiMode),
          ),
        ),
      ),
      stickyConfig,
    ),
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

export function llmProviderRowToRecord(row: LlmProvider): LlmProviderRecord {
  return toLlmProviderRecord(row);
}

/** Language model for a specific agent (adapter type/config + modelId + optional registry record). */
export function getLanguageModelForAgent(
  agent: Pick<AgentRecord, 'adapterType' | 'adapterConfig' | 'modelId'>,
  providerRecord?: LlmProviderRecord | null,
  opts?: { apiModeOverride?: ModelProviderConfig['apiMode'] },
): LanguageModelV3 {
  const overrides = modelProviderOverridesFromAgent(agent.adapterType, agent.adapterConfig);
  // Never pairs a host-mismatched adapterConfig.baseURL with the record's key/headers (409).
  const config = resolveAgentModelProviderConfig(overrides, agent.modelId, providerRecord);
  const effective =
    opts?.apiModeOverride && opts.apiModeOverride !== config.apiMode
      ? { ...config, apiMode: opts.apiModeOverride }
      : config;
  return languageModelFromConfig(effective, agent.modelId);
}

/** Embedding model using env provider settings. */
export function getEmbeddingModel(modelId: string): EmbeddingModelV3 {
  const config = resolveModelProviderConfig();
  return embeddingModelFromConfig(config, modelId);
}

/** Language model for a registry provider record + model id (e.g. Observational Memory). */
export function getLanguageModelForProviderRecordSync(
  providerRecord: LlmProviderRecord,
  modelId: string,
): LanguageModelV3 {
  const config = resolveModelProviderConfig(null, modelId, providerRecord);
  return languageModelFromConfig(config, modelId);
}

export async function getLanguageModelForProviderRecord(
  providerId: string,
  modelId: string,
): Promise<LanguageModelV3> {
  const row = await getLlmProviderRowById(providerId);
  if (!row) {
    throw new Error(`LLM provider not found: ${providerId}`);
  }
  return getLanguageModelForProviderRecordSync(llmProviderRowToRecord(row), modelId);
}

/** @deprecated Use getLanguageModelFromEnv or getLanguageModelForAgent */
export function getModelId(overrideModelId?: string | null): string {
  return resolveModelProviderConfig(null, overrideModelId).defaultModel;
}

/** @deprecated Use getLanguageModelFromEnv or getLanguageModelForAgent */
export function getLanguageModel(overrideModelId?: string | null): LanguageModelV3 {
  return getLanguageModelFromEnv(null, overrideModelId);
}

/**
 * runs-follow-default: LLM provider an agent's chat and heartbeats run against, in one place:
 * the agent's own provider → the registry default (`llm_providers.is_default`, the same default
 * /api/models lists) → env (no record). An agent `adapterConfig.baseURL` on a different host from
 * that provider never receives the provider's key or headers: resolution throws
 * ProviderConfigError `llm_provider_base_url_host_mismatch` (409) instead.
 */
export interface AgentProviderRecordResult {
  row: LlmProvider | null;
  record: LlmProviderRecord | null;
  source: AgentProviderSource;
}

/** Provider row/record for the agent (agent → registry default → null = env). */
export async function resolveAgentProviderRecord(
  agent: Pick<AgentRecord, 'providerId'>,
): Promise<AgentProviderRecordResult> {
  const { row, source } = await resolveAgentProviderRow<LlmProvider>(agent.providerId, {
    byId: getLlmProviderRowById,
    registryDefault: getDefaultLlmProviderRow,
  });
  return { row, record: row ? toLlmProviderRecord(row) : null, source };
}

/** Record plus the merged config about to be used to call the model (host-mismatch checked). */
export async function resolveAgentModelProvider(
  agent: Pick<AgentRecord, 'providerId' | 'adapterType' | 'adapterConfig' | 'modelId'>,
): Promise<AgentProviderRecordResult & { config: ModelProviderConfig }> {
  const resolved = await resolveAgentProviderRecord(agent);
  const config = resolveAgentModelProviderConfig(
    modelProviderOverridesFromAgent(agent.adapterType, agent.adapterConfig),
    agent.modelId,
    resolved.record,
  );
  return { ...resolved, config };
}
