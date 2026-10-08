import { parseAgentModelSettings, type AgentModelSettings } from './model-settings';
import { envCredentialHostRefusal, type EnvCredentialResolveOptions } from './env-credential-host';

export type ModelProviderKind =
  | 'lmstudio'
  | 'ollama'
  | 'vllm'
  | 'openai'
  | 'openai-compatible';

export const LLM_PROVIDER_TYPES = [
  'lmstudio',
  'ollama',
  'vllm',
  'openai',
  'openai-compatible',
] as const;

export type LlmProviderType = (typeof LLM_PROVIDER_TYPES)[number];

export type ModelApiMode = 'chat' | 'responses';

export interface ModelProviderConfig {
  provider: ModelProviderKind;
  apiMode: ModelApiMode;
  baseURL: string;
  apiKey: string;
  headers: Record<string, string>;
  defaultModel: string;
  providerId?: string;
  providerName?: string;
  stickiness?: StickinessType;
  stickinessHeaderName?: string;
}

export type StickinessType = 'off' | 'agent' | 'chat';

/** Shape of an llm_providers DB row used at runtime (no DB import). */
export interface LlmProviderRecord {
  id: string;
  name: string;
  type: LlmProviderType;
  baseURL: string;
  apiKey: string | null;
  headers: Record<string, string>;
  apiMode: ModelApiMode;
  isDefault: boolean;
  defaultModelSettings: AgentModelSettings;
  /** Default model id configured on the provider (null/empty = defer to env). */
  defaultModel: string | null;
  stickiness: StickinessType;
  stickinessHeaderName: string;
}

/** Per-agent overrides stored in agents.adapter_config (and env fallbacks). */
export interface ModelProviderOverrides {
  provider?: ModelProviderKind;
  apiMode?: ModelApiMode;
  baseURL?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  modelId?: string;
}

const PROVIDER_DEFAULTS: Record<
  ModelProviderKind,
  { baseURL: string; apiKey: string; defaultApiMode: ModelApiMode }
> = {
  lmstudio: {
    baseURL: 'http://localhost:1234/v1',
    apiKey: 'lm-studio',
    defaultApiMode: 'chat',
  },
  ollama: {
    baseURL: 'http://localhost:11434/v1',
    apiKey: 'ollama',
    defaultApiMode: 'chat',
  },
  vllm: {
    baseURL: 'http://localhost:8000/v1',
    apiKey: '',
    defaultApiMode: 'chat',
  },
  openai: {
    baseURL: 'https://api.openai.com/v1',
    apiKey: '',
    defaultApiMode: 'chat',
  },
  'openai-compatible': {
    baseURL: '',
    apiKey: '',
    defaultApiMode: 'chat',
  },
};

export const LLM_PROVIDER_TYPE_LABELS: Record<LlmProviderType, string> = {
  lmstudio: 'LM Studio',
  ollama: 'Ollama',
  vllm: 'vLLM',
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI-compatible',
};

export function defaultBaseURLForProviderType(type: LlmProviderType): string {
  return PROVIDER_DEFAULTS[type].baseURL;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string') headers[key] = val;
  }
  return headers;
}

export function parseLlmProviderType(value: string | undefined | null): LlmProviderType | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'lmstudio' || normalized === 'lm-studio') return 'lmstudio';
  if (normalized === 'ollama') return 'ollama';
  if (normalized === 'vllm') return 'vllm';
  if (normalized === 'openai') return 'openai';
  if (normalized === 'openai-compatible' || normalized === 'openai_compatible') {
    return 'openai-compatible';
  }
  return null;
}

export function parseModelProviderKind(value: string | undefined | null): ModelProviderKind | null {
  return parseLlmProviderType(value);
}

export function parseModelApiMode(value: string | undefined | null): ModelApiMode | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'responses') return 'responses';
  if (normalized === 'chat') return 'chat';
  return null;
}

export function parseStickinessType(value: string | undefined | null): StickinessType | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'off') return 'off';
  if (normalized === 'agent') return 'agent';
  if (normalized === 'chat') return 'chat';
  return null;
}

/** Map a DB llm_providers row to runtime config. */
export function resolveModelProviderConfigFromRecord(
  record: LlmProviderRecord,
  modelId?: string | null,
): ModelProviderConfig {
  return {
    provider: record.type,
    apiMode: record.apiMode,
    baseURL: record.baseURL,
    apiKey: record.apiKey ?? '',
    headers: record.headers,
    defaultModel:
      modelId ?? (record.defaultModel?.trim() ? record.defaultModel.trim() : envDefaultModel()),
    providerId: record.id,
    providerName: record.name,
    stickiness: record.stickiness,
    stickinessHeaderName: record.stickinessHeaderName,
  };
}

/** Build HTTP headers for provider API calls (model listing, etc.). */
export function buildProviderRequestHeaders(
  config: Pick<ModelProviderConfig, 'apiKey' | 'headers' | 'stickiness' | 'stickinessHeaderName'>,
  context?: { companyId?: string; agentId?: string; threadId?: string },
): Record<string, string> {
  const headers: Record<string, string> = { ...config.headers };
  if (config.apiKey && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  // Inject sticky session header when configured
  const stickiness = config.stickiness ?? 'off';
  const headerName = config.stickinessHeaderName?.trim() || '';
  
  if (stickiness !== 'off' && headerName && context) {
    const sessionId = buildStickySessionId(stickiness, context);
    if (sessionId) {
      headers[headerName] = sessionId;
    }
  }

  return headers;
}

/**
 * Build a stable session ID for sticky routing based on stickiness mode.
 * - agent: one stable ID per company + agent
 * - chat: one stable ID per chat thread
 */
function buildStickySessionId(
  stickiness: StickinessType,
  context: { companyId?: string; agentId?: string; threadId?: string },
): string | null {
  if (stickiness === 'agent') {
    if (context.companyId && context.agentId) {
      return `${context.companyId}:${context.agentId}`;
    }
    return null;
  }
  
  if (stickiness === 'chat') {
    if (context.threadId) {
      return context.threadId;
    }
    return null;
  }
  
  return null;
}

function envProviderKind(): ModelProviderKind {
  return parseModelProviderKind(process.env.LLM_PROVIDER) ?? 'lmstudio';
}

function envApiMode(provider: ModelProviderKind): ModelApiMode {
  return (
    parseModelApiMode(process.env.LLM_API_MODE) ??
    PROVIDER_DEFAULTS[provider].defaultApiMode
  );
}

/** Env vars that set the base URL for each provider kind, first set one wins. */
const BASE_URL_ENV: Record<ModelProviderKind, readonly string[]> = {
  ollama: ['OLLAMA_BASE_URL', 'LLM_BASE_URL'],
  vllm: ['LLM_BASE_URL'],
  openai: ['OPENAI_BASE_URL', 'LLM_BASE_URL'],
  'openai-compatible': ['LLM_BASE_URL', 'OPENAI_BASE_URL'],
  lmstudio: ['LM_STUDIO_BASE_URL', 'LLM_BASE_URL'],
};

/** True when the env var is set and not blank/whitespace-only (matches apps/web envSet). */
function envVarSet(name: string): boolean {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '';
}

/** Name of the env var the base URL comes from, or null when the built-in default is used. */
function envBaseURLName(provider: ModelProviderKind): string | null {
  const names = BASE_URL_ENV[provider] ?? BASE_URL_ENV.lmstudio;
  return names.find((name) => envVarSet(name)) ?? null;
}

function envBaseURL(provider: ModelProviderKind): string {
  const name = envBaseURLName(provider);
  if (name) return (process.env[name] ?? '').trim();
  return (PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.lmstudio).baseURL;
}

/** Env vars that hold the API key for each provider kind, first set one wins. */
const API_KEY_ENV: Record<ModelProviderKind, readonly string[]> = {
  ollama: ['OLLAMA_API_KEY', 'LLM_API_KEY'],
  vllm: ['LLM_API_KEY'],
  openai: ['LLM_API_KEY', 'OPENAI_API_KEY'],
  'openai-compatible': ['LLM_API_KEY', 'OPENAI_API_KEY'],
  lmstudio: ['LM_STUDIO_API_KEY', 'LLM_API_KEY'],
};

/** Name of the env var the API key comes from, or null when the built-in placeholder is used. */
function envApiKeyName(provider: ModelProviderKind): string | null {
  const names = API_KEY_ENV[provider] ?? API_KEY_ENV.lmstudio;
  return names.find((name) => process.env[name] !== undefined) ?? null;
}

function envApiKey(provider: ModelProviderKind): string {
  const name = envApiKeyName(provider);
  if (name) return process.env[name] ?? '';
  return (PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.lmstudio).apiKey;
}

function envDefaultModel(): string {
  return (
    process.env.LLM_DEFAULT_MODEL ??
    process.env.LM_STUDIO_DEFAULT_MODEL ??
    process.env.OLLAMA_DEFAULT_MODEL ??
    'meta-llama/Llama-3.3-70B-Instruct'
  );
}

function applyOverrides(
  base: ModelProviderConfig,
  overrides?: ModelProviderOverrides | null,
  modelId?: string | null,
): ModelProviderConfig {
  if (!overrides) {
    return {
      ...base,
      defaultModel: modelId ?? base.defaultModel,
    };
  }

  return {
    provider: overrides.provider ?? base.provider,
    apiMode: overrides.apiMode ?? base.apiMode,
    baseURL: overrides.baseURL?.trim() || base.baseURL,
    apiKey: overrides.apiKey ?? base.apiKey,
    headers: overrides.headers ? { ...base.headers, ...overrides.headers } : base.headers,
    defaultModel: modelId ?? overrides.modelId ?? base.defaultModel,
    providerId: base.providerId,
    providerName: base.providerName,
  };
}

/**
 * Resolve model provider settings.
 * Priority: registry record → per-agent adapter overrides → env defaults.
 */
export function resolveModelProviderConfig(
  overrides?: ModelProviderOverrides | null,
  modelId?: string | null,
  providerRecord?: LlmProviderRecord | null,
  options?: EnvCredentialResolveOptions,
): ModelProviderConfig {
  const base = providerRecord
    ? resolveModelProviderConfigFromRecord(providerRecord, modelId)
    : resolveModelProviderConfigFromEnv(overrides, modelId, options);

  return applyOverrides(base, overrides, modelId);
}

/** Resolve from env only (no registry record). */
export function resolveModelProviderConfigFromEnv(
  overrides?: ModelProviderOverrides | null,
  modelId?: string | null,
  options?: EnvCredentialResolveOptions,
): ModelProviderConfig {
  const provider = overrides?.provider ?? envProviderKind();
  const apiMode = overrides?.apiMode ?? envApiMode(provider);
  // A server env API key only goes to the env-configured base URL host for this provider kind,
  // or to the kind's built-in default host when this kind is the env kind (LLM_PROVIDER). Any
  // other host (an agent base URL override, or a provider-kind change with no env base URL for
  // that kind) throws EnvCredentialHostError (409), or with `onEnvCredentialHostMismatch:
  // 'omit-key'` resolves without the key.
  const configuredBaseURL = envBaseURL(provider);
  const overrideBaseURL = overrides?.baseURL?.trim();
  const baseURL = overrideBaseURL || configuredBaseURL;
  let apiKey = overrides?.apiKey ?? envApiKey(provider);
  const keyEnvName = overrides?.apiKey === undefined ? envApiKeyName(provider) : null;
  if (keyEnvName && apiKey !== '') {
    const envKind = envProviderKind();
    const keyBaseURL =
      envBaseURLName(provider) !== null || provider === envKind ? configuredBaseURL : null;
    if (overrideBaseURL || keyBaseURL === null) {
      const refusal = envCredentialHostRefusal({
        providerLabel: LLM_PROVIDER_TYPE_LABELS[provider] ?? provider,
        keyEnvName,
        configuredBaseURL: keyBaseURL,
        requestBaseURL: baseURL,
      });
      if (refusal) {
        if (options?.onEnvCredentialHostMismatch !== 'omit-key') throw refusal;
        apiKey = '';
      }
    }
  }
  const defaultModel = modelId ?? overrides?.modelId ?? envDefaultModel();

  return {
    provider,
    apiMode,
    baseURL,
    apiKey,
    headers: overrides?.headers ?? {},
    defaultModel,
  };
}

/** Map agent adapter fields to model provider overrides. */
export function modelProviderOverridesFromAgent(
  adapterType: string,
  adapterConfig: unknown,
): ModelProviderOverrides {
  const cfg = isRecord(adapterConfig) ? adapterConfig : {};
  const overrides: ModelProviderOverrides = {};

  if (adapterType === 'harness_local') {
    const harnessProvider = parseModelProviderKind(
      typeof cfg.provider === 'string' ? cfg.provider : undefined,
    );
    if (harnessProvider) overrides.provider = harnessProvider;
  } else {
    const adapterProvider = parseModelProviderKind(adapterType);
    if (adapterProvider) overrides.provider = adapterProvider;
  }

  const configProvider = parseModelProviderKind(
    typeof cfg.provider === 'string' ? cfg.provider : undefined,
  );
  if (configProvider) overrides.provider = configProvider;

  const apiMode = parseModelApiMode(typeof cfg.apiMode === 'string' ? cfg.apiMode : undefined);
  if (apiMode) overrides.apiMode = apiMode;

  if (typeof cfg.baseURL === 'string' && cfg.baseURL.trim()) {
    overrides.baseURL = cfg.baseURL.trim();
  }

  if (typeof cfg.apiKey === 'string') overrides.apiKey = cfg.apiKey;

  const headers = parseHeaders(cfg.headers);
  if (Object.keys(headers).length > 0) overrides.headers = headers;

  return overrides;
}

export function toLlmProviderRecord(row: {
  id: string;
  name: string;
  type: string;
  baseURL: string;
  apiKey: string | null;
  headers: unknown;
  apiMode: string;
  isDefault: boolean;
  defaultModelSettings?: unknown;
  defaultModel?: string | null;
  stickiness?: string;
  stickinessHeaderName?: string;
}): LlmProviderRecord {
  const type = parseLlmProviderType(row.type);
  if (!type) {
    throw new Error(`Invalid LLM provider type: ${row.type}`);
  }
  const apiMode = parseModelApiMode(row.apiMode) ?? 'chat';
  const stickiness = parseStickinessType(row.stickiness) ?? 'off';
  const stickinessHeaderName = typeof row.stickinessHeaderName === 'string' && row.stickinessHeaderName.trim()
    ? row.stickinessHeaderName.trim()
    : 'x-litellm-session-id';
  return {
    id: row.id,
    name: row.name,
    type,
    baseURL: row.baseURL,
    apiKey: row.apiKey,
    headers: parseHeaders(row.headers),
    apiMode,
    isDefault: row.isDefault,
    defaultModelSettings: parseAgentModelSettings(row.defaultModelSettings),
    defaultModel:
      typeof row.defaultModel === 'string' && row.defaultModel.trim()
        ? row.defaultModel.trim()
        : null,
    stickiness,
    stickinessHeaderName,
  };
}

/** Default adapter_type for new agents based on env LLM_PROVIDER. */
export function defaultAgentAdapterType(): 'lmstudio' | 'ollama' {
  const provider = envProviderKind();
  return provider === 'ollama' ? 'ollama' : 'lmstudio';
}

/** Display name for env-based default provider seeding. */
export function defaultProviderSeedName(type: LlmProviderType): string {
  return `Default (${LLM_PROVIDER_TYPE_LABELS[type]})`;
}
