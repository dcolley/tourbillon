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
  if (!enabled && !providerId && !modelId) return undefined;
  return {
    enabled,
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
  };
}

function parseHitlyGateSettings(raw: unknown): HitlyGateSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const enabled = record.enabled === true;
  const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim() || undefined : undefined;
  const projectId = typeof record.projectId === 'string' ? record.projectId.trim() || undefined : undefined;
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() || undefined : undefined;
  const types = Array.isArray(record.types)
    ? record.types.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : undefined;
  
  if (!enabled && !baseUrl && !projectId && !apiKey && !types) return undefined;
  return {
    enabled,
    ...(baseUrl ? { baseUrl } : {}),
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
    };
  }
  if (patch.hitlyGate !== undefined) {
    const hg = patch.hitlyGate;
    next.hitlyGate = {
      enabled: hg.enabled === true,
      ...(hg.baseUrl?.trim() ? { baseUrl: hg.baseUrl.trim() } : {}),
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
  const projectId = hg.projectId?.trim();
  const apiKey = hg.apiKey?.trim();
  if (!baseUrl || !projectId || !apiKey) return null;
  return {
    enabled: true,
    baseUrl: baseUrl.replace(/\/+$/, ''),
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
