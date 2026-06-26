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
}

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
    defaultModel: modelId ?? envDefaultModel(),
    providerId: record.id,
    providerName: record.name,
  };
}

/** Build HTTP headers for provider API calls (model listing, etc.). */
export function buildProviderRequestHeaders(
  config: Pick<ModelProviderConfig, 'apiKey' | 'headers'>,
): Record<string, string> {
  const headers: Record<string, string> = { ...config.headers };
  if (config.apiKey && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
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

function envBaseURL(provider: ModelProviderKind): string {
  switch (provider) {
    case 'ollama':
      return (
        process.env.OLLAMA_BASE_URL ??
        process.env.LLM_BASE_URL ??
        PROVIDER_DEFAULTS.ollama.baseURL
      );
    case 'vllm':
      return process.env.LLM_BASE_URL ?? PROVIDER_DEFAULTS.vllm.baseURL;
    case 'openai':
      return (
        process.env.OPENAI_BASE_URL ??
        process.env.LLM_BASE_URL ??
        PROVIDER_DEFAULTS.openai.baseURL
      );
    case 'openai-compatible':
      return (
        process.env.LLM_BASE_URL ??
        process.env.OPENAI_BASE_URL ??
        PROVIDER_DEFAULTS['openai-compatible'].baseURL
      );
    case 'lmstudio':
    default:
      return (
        process.env.LM_STUDIO_BASE_URL ??
        process.env.LLM_BASE_URL ??
        PROVIDER_DEFAULTS.lmstudio.baseURL
      );
  }
}

function envApiKey(provider: ModelProviderKind): string {
  switch (provider) {
    case 'ollama':
      return (
        process.env.OLLAMA_API_KEY ??
        process.env.LLM_API_KEY ??
        PROVIDER_DEFAULTS.ollama.apiKey
      );
    case 'vllm':
      return process.env.LLM_API_KEY ?? PROVIDER_DEFAULTS.vllm.apiKey;
    case 'openai':
      return process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
    case 'openai-compatible':
      return process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
    case 'lmstudio':
    default:
      return (
        process.env.LM_STUDIO_API_KEY ??
        process.env.LLM_API_KEY ??
        PROVIDER_DEFAULTS.lmstudio.apiKey
      );
  }
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
): ModelProviderConfig {
  const base = providerRecord
    ? resolveModelProviderConfigFromRecord(providerRecord, modelId)
    : resolveModelProviderConfigFromEnv(overrides, modelId);

  return applyOverrides(base, overrides, modelId);
}

/** Resolve from env only (no registry record). */
export function resolveModelProviderConfigFromEnv(
  overrides?: ModelProviderOverrides | null,
  modelId?: string | null,
): ModelProviderConfig {
  const provider = overrides?.provider ?? envProviderKind();
  const apiMode = overrides?.apiMode ?? envApiMode(provider);
  const baseURL = overrides?.baseURL?.trim() || envBaseURL(provider);
  const apiKey = overrides?.apiKey ?? envApiKey(provider);
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

/** Convert a Drizzle llm_providers row to LlmProviderRecord. */
export function toLlmProviderRecord(row: {
  id: string;
  name: string;
  type: string;
  baseURL: string;
  apiKey: string | null;
  headers: unknown;
  apiMode: string;
  isDefault: boolean;
}): LlmProviderRecord {
  const type = parseLlmProviderType(row.type);
  if (!type) {
    throw new Error(`Invalid LLM provider type: ${row.type}`);
  }
  const apiMode = parseModelApiMode(row.apiMode) ?? 'chat';
  return {
    id: row.id,
    name: row.name,
    type,
    baseURL: row.baseURL,
    apiKey: row.apiKey,
    headers: parseHeaders(row.headers),
    apiMode,
    isDefault: row.isDefault,
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
