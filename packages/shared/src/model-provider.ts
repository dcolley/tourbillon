export type ModelProviderKind = 'lmstudio' | 'ollama' | 'openai-compatible';
export type ModelApiMode = 'chat' | 'responses';

export interface ModelProviderConfig {
  provider: ModelProviderKind;
  apiMode: ModelApiMode;
  baseURL: string;
  apiKey: string;
  defaultModel: string;
}

/** Per-agent overrides stored in agents.adapter_config (and env fallbacks). */
export interface ModelProviderOverrides {
  provider?: ModelProviderKind;
  apiMode?: ModelApiMode;
  baseURL?: string;
  apiKey?: string;
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
  'openai-compatible': {
    baseURL: '',
    apiKey: '',
    defaultApiMode: 'chat',
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseModelProviderKind(value: string | undefined | null): ModelProviderKind | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'lmstudio' || normalized === 'lm-studio') return 'lmstudio';
  if (normalized === 'ollama') return 'ollama';
  if (normalized === 'openai-compatible' || normalized === 'openai') return 'openai-compatible';
  return null;
}

export function parseModelApiMode(value: string | undefined | null): ModelApiMode | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'responses') return 'responses';
  if (normalized === 'chat') return 'chat';
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

function envBaseURL(provider: ModelProviderKind): string {
  switch (provider) {
    case 'ollama':
      return (
        process.env.OLLAMA_BASE_URL ??
        process.env.LLM_BASE_URL ??
        PROVIDER_DEFAULTS.ollama.baseURL
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

/** Resolve model provider settings from env, with optional per-agent overrides. */
export function resolveModelProviderConfig(
  overrides?: ModelProviderOverrides | null,
  modelId?: string | null,
): ModelProviderConfig {
  const provider =
    overrides?.provider ??
    envProviderKind();

  const apiMode =
    overrides?.apiMode ??
    envApiMode(provider);

  const baseURL =
    overrides?.baseURL?.trim() ||
    envBaseURL(provider);

  const apiKey =
    overrides?.apiKey ??
    envApiKey(provider);

  const defaultModel =
    modelId ??
    overrides?.modelId ??
    envDefaultModel();

  return { provider, apiMode, baseURL, apiKey, defaultModel };
}

/** Map agent adapter fields to model provider overrides. */
export function modelProviderOverridesFromAgent(
  adapterType: string,
  adapterConfig: unknown,
): ModelProviderOverrides {
  const cfg = isRecord(adapterConfig) ? adapterConfig : {};
  const overrides: ModelProviderOverrides = {};

  // harness_local stores LLM provider in adapter_config.provider
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

  return overrides;
}

/** Default adapter_type for new agents based on env LLM_PROVIDER. */
export function defaultAgentAdapterType(): 'lmstudio' | 'ollama' {
  const provider = envProviderKind();
  return provider === 'ollama' ? 'ollama' : 'lmstudio';
}
