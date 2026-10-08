import { parseAgentModelSettings, type AgentModelSettings } from './model-settings';

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

/**
 * {@link resolveModelProviderConfig} for config that is about to be used to call the provider
 * (runs, chat, model listing). Throws `llm_provider_base_url_host_mismatch` (409) instead of
 * combining an agent base URL override on another host with the provider's key or headers.
 * Display-only callers keep using resolveModelProviderConfig.
 */
export function resolveAgentModelProviderConfig(
  overrides?: ModelProviderOverrides | null,
  modelId?: string | null,
  providerRecord?: LlmProviderRecord | null,
): ModelProviderConfig {
  assertAgentOverrideWithinProviderBoundary(overrides, providerRecord);
  return resolveModelProviderConfig(overrides, modelId, providerRecord);
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

// ---------------------------------------------------------------------------------------------
/**
 * runs-follow-default: credential boundary for LLM provider calls (shared by the web app, the wake-runner and mastra).
 *
 * - {@link ProviderConfigError}: a provider config that can never work safely (409 + code).
 * - {@link sameCredentialBoundary}: same host and port, no https → http downgrade.
 * - {@link assertAgentOverrideWithinProviderBoundary}: an agent's `adapterConfig.baseURL` on a
 *   different host from its provider never receives the provider's API key or header values.
 * - {@link resolveAgentProviderRow}: agent's provider → registry default → env (null).
 */

export type ProviderConfigErrorCode =
  | 'llm_provider_base_url_credentials'
  | 'llm_provider_base_url_host_mismatch';

/** A provider config that can never work (not an upstream failure): maps to 409. */
export class ProviderConfigError extends Error {
  readonly status = 409;
  constructor(
    message: string,
    readonly code: ProviderConfigErrorCode,
  ) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

/**
 * Structural check (works across bundles that may hold separate copies of this module, e.g. the
 * web app vs @tourbillon/mastra in Next.js).
 */
export function isProviderConfigError(err: unknown): err is ProviderConfigError {
  if (err instanceof ProviderConfigError) return true;
  if (!(err instanceof Error) || err.name !== 'ProviderConfigError') return false;
  const e = err as Error & { code?: unknown; status?: unknown };
  return typeof e.code === 'string' && e.code.startsWith('llm_provider_') && e.status === 409;
}

function tryParseURL(raw: string): URL | null {
  try {
    return new URL(raw.trim());
  } catch {
    return null;
  }
}

/**
 * Same trust boundary for credentials: same host (hostname and port) and not an https → http
 * downgrade. http → https on the same hostname with default ports is allowed.
 */
export function sameCredentialBoundary(from: string | URL, to: string | URL): boolean {
  const a = typeof from === 'string' ? tryParseURL(from) : from;
  const b = typeof to === 'string' ? tryParseURL(to) : to;
  if (!a || !b) return false;
  if (a.hostname.toLowerCase() !== b.hostname.toLowerCase()) return false;
  if (a.protocol === b.protocol) return a.port === b.port;
  // Upgrade only, and only between default ports (http://h → https://h).
  return a.protocol === 'http:' && b.protocol === 'https:' && a.port === '' && b.port === '';
}

/** `scheme://host[:port]` for messages: never userinfo, path or query. */
function originForMessage(raw: string): string {
  const u = tryParseURL(raw);
  return u ? `${u.protocol}//${u.host}` : 'an unparseable URL';
}

/** Provider credentials (key, header values) that would be sent along with these overrides. */
export function providerCredentialsSentWithOverrides(
  record: Pick<LlmProviderRecord, 'apiKey' | 'headers'>,
  overrides?: Pick<ModelProviderOverrides, 'apiKey' | 'headers'> | null,
): { apiKey: boolean; headerNames: string[] } {
  // Same rule as the merge in resolveModelProviderConfig ({ ...record.headers, ...overrides }):
  // only an exact-name override replaces a provider header. A different-case name does not
  // (both would be sent), so it doesn't count as replaced.
  const overridden = overrides?.headers ?? {};
  return {
    apiKey: overrides?.apiKey === undefined && Boolean(record.apiKey),
    headerNames: Object.keys(record.headers ?? {}).filter((k) => !Object.hasOwn(overridden, k)),
  };
}

/**
 * Fail closed when an agent's base URL override sits outside its provider's credential boundary
 * and the provider's API key or header values would be sent to it. A same-host override (or an
 * override that brings its own key and no provider headers are left) is allowed.
 * Throws {@link ProviderConfigError} `llm_provider_base_url_host_mismatch` (409).
 */
export function assertAgentOverrideWithinProviderBoundary(
  overrides: ModelProviderOverrides | null | undefined,
  record: LlmProviderRecord | null | undefined,
): void {
  const overrideURL = overrides?.baseURL?.trim();
  if (!record || !overrideURL) return;
  const sent = providerCredentialsSentWithOverrides(record, overrides);
  if (!sent.apiKey && sent.headerNames.length === 0) return;
  if (sameCredentialBoundary(record.baseURL, overrideURL)) return;
  const what = [sent.apiKey ? 'API key' : null, sent.headerNames.length ? 'custom headers' : null]
    .filter(Boolean)
    .join(' and ');
  throw new ProviderConfigError(
    `The agent's base URL override (${originForMessage(overrideURL)}) is on a different host from ` +
      `its LLM provider "${record.name}" (${originForMessage(record.baseURL)}); refusing to send ` +
      `the provider's ${what} there. Remove the agent's base URL override, or point the agent at ` +
      'a provider for that host.',
    'llm_provider_base_url_host_mismatch',
  );
}

export type AgentProviderSource = 'agent' | 'registry_default' | 'env';

/**
 * Provider row used for an agent's runs and chat: the agent's own provider, else the registry
 * default (`llm_providers.is_default`, the same default `/api/models` lists), else null → env.
 * An agent provider id whose row is gone falls through to the registry default.
 */
export async function resolveAgentProviderRow<T>(
  providerId: string | null | undefined,
  lookup: {
    byId: (id: string) => Promise<T | null | undefined>;
    registryDefault: () => Promise<T | null | undefined>;
  },
): Promise<{ row: T | null; source: AgentProviderSource }> {
  if (providerId) {
    const own = await lookup.byId(providerId);
    if (own) return { row: own, source: 'agent' };
  }
  const fallback = await lookup.registryDefault();
  if (fallback) return { row: fallback, source: 'registry_default' };
  return { row: null, source: 'env' };
}
