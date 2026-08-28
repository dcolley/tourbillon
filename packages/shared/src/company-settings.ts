import type {
  AgentRuntimeConfig,
  CompanySettings,
  HitlyGateSettings,
  ObservationalMemorySettings,
} from './types';

function trimRecord(values: unknown): Record<string, string> | undefined {
  if (!values || typeof values !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim()) {
      out[key] = value.trim();
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseObservationalMemorySettings(raw: unknown): ObservationalMemorySettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const providerId =
    typeof record.providerId === 'string' ? record.providerId.trim() || undefined : undefined;
  const modelId =
    typeof record.modelId === 'string' ? record.modelId.trim() || undefined : undefined;
  const enabled = record.enabled === true;
  
  const maxOutputTokens = typeof record.maxOutputTokens === 'number' ? record.maxOutputTokens : undefined;
  const observeAfterTokens = typeof record.observeAfterTokens === 'number' ? record.observeAfterTokens : undefined;
  const reflectAfterTokens = typeof record.reflectAfterTokens === 'number' ? record.reflectAfterTokens : undefined;
  const temperature = typeof record.temperature === 'number' ? record.temperature : undefined;
  
  if (!enabled && !providerId && !modelId && maxOutputTokens === undefined && 
      observeAfterTokens === undefined && reflectAfterTokens === undefined && temperature === undefined) {
    return undefined;
  }
  
  return {
    enabled,
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(observeAfterTokens !== undefined ? { observeAfterTokens } : {}),
    ...(reflectAfterTokens !== undefined ? { reflectAfterTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
  };
}

function parseHitlyGateSettings(raw: unknown): HitlyGateSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const enabled = record.enabled === true;
  const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim() || undefined : undefined;
  const resumeHost = typeof record.resumeHost === 'string' ? record.resumeHost.trim() || undefined : undefined;
  const projectId = typeof record.projectId === 'string' ? record.projectId.trim() || undefined : undefined;
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() || undefined : undefined;
  const types = Array.isArray(record.types)
    ? record.types.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : undefined;
  
  if (!enabled && !baseUrl && !resumeHost && !projectId && !apiKey && !types) return undefined;
  return {
    enabled,
    ...(baseUrl ? { baseUrl } : {}),
    ...(resumeHost ? { resumeHost } : {}),
    ...(projectId ? { projectId } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(types && types.length > 0 ? { types } : {}),
  };
}

export function parseCompanySettings(raw: unknown): CompanySettings {
  if (!raw || typeof raw !== 'object') return {};
  const record = raw as Record<string, unknown>;
  return {
    mcpCredentials: trimRecord(record.mcpCredentials),
    searxngUrl: typeof record.searxngUrl === 'string' ? record.searxngUrl.trim() || undefined : undefined,
    searxngApiKey:
      typeof record.searxngApiKey === 'string' ? record.searxngApiKey.trim() || undefined : undefined,
    tavilyApiKey:
      typeof record.tavilyApiKey === 'string' ? record.tavilyApiKey.trim() || undefined : undefined,
    observationalMemory: parseObservationalMemorySettings(record.observationalMemory),
    hitlyGate: parseHitlyGateSettings(record.hitlyGate),
  };
}

export function mergeCompanySettings(
  current: unknown,
  patch: Partial<CompanySettings>,
): CompanySettings {
  const base = parseCompanySettings(current);
  const next: CompanySettings = { ...base };

  if (patch.searxngUrl !== undefined) {
    next.searxngUrl = patch.searxngUrl.trim() || undefined;
  }
  if (patch.searxngApiKey !== undefined) {
    next.searxngApiKey = patch.searxngApiKey.trim() || undefined;
  }
  if (patch.tavilyApiKey !== undefined) {
    next.tavilyApiKey = patch.tavilyApiKey.trim() || undefined;
  }
  if (patch.mcpCredentials !== undefined) {
    const merged = { ...base.mcpCredentials, ...patch.mcpCredentials };
    for (const [key, value] of Object.entries(merged)) {
      if (!value?.trim()) delete merged[key];
    }
    if (Object.keys(merged).length > 0) {
      next.mcpCredentials = merged;
    } else {
      delete next.mcpCredentials;
    }
  }
  if (patch.observationalMemory !== undefined) {
    const om = patch.observationalMemory;
    next.observationalMemory = {
      enabled: om.enabled === true,
      ...(om.providerId?.trim() ? { providerId: om.providerId.trim() } : {}),
      ...(om.modelId?.trim() ? { modelId: om.modelId.trim() } : {}),
      ...(om.maxOutputTokens !== undefined ? { maxOutputTokens: om.maxOutputTokens } : {}),
      ...(om.observeAfterTokens !== undefined ? { observeAfterTokens: om.observeAfterTokens } : {}),
      ...(om.reflectAfterTokens !== undefined ? { reflectAfterTokens: om.reflectAfterTokens } : {}),
      ...(om.temperature !== undefined ? { temperature: om.temperature } : {}),
    };
  }
  if (patch.hitlyGate !== undefined) {
    const hg = patch.hitlyGate;
    next.hitlyGate = {
      enabled: hg.enabled === true,
      ...(hg.baseUrl?.trim() ? { baseUrl: hg.baseUrl.trim() } : {}),
      ...(hg.resumeHost?.trim() ? { resumeHost: hg.resumeHost.trim() } : {}),
      ...(hg.projectId?.trim() ? { projectId: hg.projectId.trim() } : {}),
      ...(hg.apiKey?.trim() ? { apiKey: hg.apiKey.trim() } : {}),
      ...(hg.types && hg.types.length > 0 ? { types: hg.types } : {}),
    };
  }

  return next;
}

/** Resolved OM compaction model when enabled with both provider and model set. */
export function resolveObservationalMemoryModel(
  companySettings?: CompanySettings | null,
): { providerId: string; modelId: string } | null {
  const om = companySettings?.observationalMemory;
  if (!om?.enabled) return null;
  const providerId = om.providerId?.trim();
  const modelId = om.modelId?.trim();
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

export function isObservationalMemoryConfigured(
  companySettings?: CompanySettings | null,
): boolean {
  return resolveObservationalMemoryModel(companySettings) !== null;
}

/** OM defaults (min 1024, min 8000, min 8000). */
const DEFAULT_OM_MAX_OUTPUT_TOKENS = 8192;
const DEFAULT_OM_OBSERVE_AFTER_TOKENS = 30_000;
const DEFAULT_OM_REFLECT_AFTER_TOKENS = 40_000;
const MIN_OM_MAX_OUTPUT_TOKENS = 1024;
const MIN_OM_OBSERVE_AFTER_TOKENS = 8_000;
const MIN_OM_REFLECT_AFTER_TOKENS = 8_000;

/** Resolve OM settings with defaults applied. */
export function resolveObservationalMemorySettings(
  companySettings?: CompanySettings | null,
): {
  maxOutputTokens: number;
  observeAfterTokens: number;
  reflectAfterTokens: number;
  temperature?: number;
} {
  const om = companySettings?.observationalMemory;
  return {
    maxOutputTokens: Math.max(
      om?.maxOutputTokens ?? DEFAULT_OM_MAX_OUTPUT_TOKENS,
      MIN_OM_MAX_OUTPUT_TOKENS,
    ),
    observeAfterTokens: Math.max(
      om?.observeAfterTokens ?? DEFAULT_OM_OBSERVE_AFTER_TOKENS,
      MIN_OM_OBSERVE_AFTER_TOKENS,
    ),
    reflectAfterTokens: Math.max(
      om?.reflectAfterTokens ?? DEFAULT_OM_REFLECT_AFTER_TOKENS,
      MIN_OM_REFLECT_AFTER_TOKENS,
    ),
    ...(om?.temperature !== undefined ? { temperature: om.temperature } : {}),
  };
}

/**
 * Resolved per-agent Observational Memory settings.
 * Includes full config with thresholds when OM is active, or null when off.
 */
export interface ResolvedObservationalMemoryConfig {
  providerId: string;
  modelId: string;
  maxOutputTokens: number;
  observeAfterTokens: number;
  reflectAfterTokens: number;
  temperature?: number;
}

/**
 * Resolve per-agent Observational Memory config based on mode and overrides.
 * 
 * Resolution rules:
 * - mode='inherit' or missing: use company OM settings
 * - mode='off': OM disabled regardless of company settings
 * - mode='on': OM enabled with agent overrides merged over company defaults
 * 
 * For mode='on', each override field inherits from company if not set on agent.
 * Returns null if resolved config lacks both provider and model.
 */
export function resolveAgentObservationalMemory(
  companySettings?: CompanySettings | null,
  agentRuntime?: { observationalMemory?: AgentRuntimeConfig['observationalMemory'] } | null,
): ResolvedObservationalMemoryConfig | null {
  const agentOm = agentRuntime?.observationalMemory;
  const mode = agentOm?.mode ?? 'inherit';

  if (mode === 'off') {
    return null;
  }

  const companyOm = companySettings?.observationalMemory;

  if (mode === 'inherit') {
    // Inherit from company
    if (!companyOm?.enabled) return null;
    const providerId = companyOm.providerId?.trim();
    const modelId = companyOm.modelId?.trim();
    if (!providerId || !modelId) return null;
    return {
      providerId,
      modelId,
      maxOutputTokens: companyOm.maxOutputTokens ?? DEFAULT_OM_MAX_OUTPUT_TOKENS,
      observeAfterTokens: companyOm.observeAfterTokens ?? DEFAULT_OM_OBSERVE_AFTER_TOKENS,
      reflectAfterTokens: companyOm.reflectAfterTokens ?? DEFAULT_OM_REFLECT_AFTER_TOKENS,
      temperature: companyOm.temperature,
    };
  }

  // mode === 'on': merge agent overrides over company, then defaults
  const agentProviderId = agentOm?.providerId?.trim();
  const agentModelId = agentOm?.modelId?.trim();
  const companyProviderId = companyOm?.providerId?.trim();
  const companyModelId = companyOm?.modelId?.trim();

  const providerId = agentProviderId || companyProviderId;
  const modelId = agentModelId || companyModelId;

  if (!providerId || !modelId) {
    // mode=on but no resolvable model — OM stays off
    return null;
  }

  return {
    providerId,
    modelId,
    maxOutputTokens:
      agentOm?.maxOutputTokens ??
      companyOm?.maxOutputTokens ??
      DEFAULT_OM_MAX_OUTPUT_TOKENS,
    observeAfterTokens:
      agentOm?.observeAfterTokens ??
      companyOm?.observeAfterTokens ??
      DEFAULT_OM_OBSERVE_AFTER_TOKENS,
    reflectAfterTokens:
      agentOm?.reflectAfterTokens ??
      companyOm?.reflectAfterTokens ??
      DEFAULT_OM_REFLECT_AFTER_TOKENS,
    temperature: agentOm?.temperature ?? companyOm?.temperature,
  };
}

/**
 * Stable cache key for Memory instances keyed by resolved OM config.
 * When OM is off or unconfigured, returns 'base'.
 * When OM is on, returns 'om:{providerId}:{modelId}:{maxOutputTokens}:{observeAfterTokens}:{reflectAfterTokens}[:{temperature}]'.
 * Temperature is included only when defined.
 */
export function memoryCacheKeyForAgent(
  companySettings?: CompanySettings | null,
  agentRuntime?: { observationalMemory?: AgentRuntimeConfig['observationalMemory'] } | null,
): string {
  const resolved = resolveAgentObservationalMemory(companySettings, agentRuntime);
  if (!resolved) return 'base';
  const tempPart = resolved.temperature !== undefined ? `:${resolved.temperature}` : '';
  return `om:${resolved.providerId}:${resolved.modelId}:${resolved.maxOutputTokens}:${resolved.observeAfterTokens}:${resolved.reflectAfterTokens}${tempPart}`;
}

/**
 * Whether this agent uses Observational Memory (resolved mode is not off and has model).
 */
export function isAgentObservationalMemoryConfigured(
  companySettings?: CompanySettings | null,
  agentRuntime?: { observationalMemory?: AgentRuntimeConfig['observationalMemory'] } | null,
): boolean {
  return resolveAgentObservationalMemory(companySettings, agentRuntime) !== null;
}

export function resolveSearxngBaseUrl(
  companySettings?: CompanySettings | null,
  agentRuntime?: AgentRuntimeConfig | null,
): string | null {
  const fromAgent = agentRuntime?.searxngUrl?.trim();
  if (fromAgent) return fromAgent.replace(/\/+$/, '');

  const fromCompany = companySettings?.searxngUrl?.trim();
  if (fromCompany) return fromCompany.replace(/\/+$/, '');

  const fromEnv = process.env.SEARXNG_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');

  return null;
}

export function resolveSearxngAuth(
  companySettings?: CompanySettings | null,
  agentRuntime?: AgentRuntimeConfig | null,
): string | null {
  const fromAgent = agentRuntime?.searxngApiKey?.trim();
  if (fromAgent) return fromAgent;

  const fromCompany = companySettings?.searxngApiKey?.trim();
  if (fromCompany) return fromCompany;

  const fromEnv = process.env.SEARXNG_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  return null;
}

export function isSearxngConfigured(
  companySettings?: CompanySettings | null,
  agentRuntime?: AgentRuntimeConfig | null,
): boolean {
  return resolveSearxngBaseUrl(companySettings, agentRuntime) !== null;
}

export function resolveTavilyApiKey(
  companySettings?: CompanySettings | null,
  agentRuntime?: AgentRuntimeConfig | null,
): string | null {
  const fromAgent = agentRuntime?.tavilyApiKey?.trim();
  if (fromAgent) return fromAgent;

  const fromCompany = companySettings?.tavilyApiKey?.trim();
  if (fromCompany) return fromCompany;

  const fromEnv = process.env.TAVILY_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  return null;
}

export function isTavilyConfigured(
  companySettings?: CompanySettings | null,
  agentRuntime?: AgentRuntimeConfig | null,
): boolean {
  return resolveTavilyApiKey(companySettings, agentRuntime) !== null;
}

export function resolveHitlyGate(
  companySettings?: CompanySettings | null,
): HitlyGateSettings | null {
  const hg = companySettings?.hitlyGate;
  if (!hg?.enabled) return null;
  const baseUrl = hg.baseUrl?.trim();
  const resumeHost = hg.resumeHost?.trim();
  const projectId = hg.projectId?.trim();
  const apiKey = hg.apiKey?.trim();
  if (!baseUrl || !resumeHost || !projectId || !apiKey) return null;
  return {
    enabled: true,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    resumeHost: resumeHost.replace(/\/+$/, ''),
    projectId,
    apiKey,
    ...(hg.types && hg.types.length > 0 ? { types: hg.types } : {}),
  };
}

export function isHitlyGateConfigured(
  companySettings?: CompanySettings | null,
): boolean {
  return resolveHitlyGate(companySettings) !== null;
}
