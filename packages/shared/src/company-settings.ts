import type { AgentRuntimeConfig, CompanySettings } from './types';

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

export function parseCompanySettings(raw: unknown): CompanySettings {
  if (!raw || typeof raw !== 'object') return {};
  const record = raw as Record<string, unknown>;
  return {
    mcpCredentials: trimRecord(record.mcpCredentials),
    searxngUrl: typeof record.searxngUrl === 'string' ? record.searxngUrl.trim() || undefined : undefined,
    searxngApiKey:
      typeof record.searxngApiKey === 'string' ? record.searxngApiKey.trim() || undefined : undefined,
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

  return next;
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
