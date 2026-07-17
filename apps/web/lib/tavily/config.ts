import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import {
  parseCompanySettings,
  resolveTavilyApiKey,
  type CompanySettings,
} from '@tourbillon/shared';
import type { AgentRuntimeConfig } from '@tourbillon/shared';

let rootEnvLoaded = false;

function ensureRootEnvLoaded(): void {
  if (rootEnvLoaded) return;
  rootEnvLoaded = true;

  if (process.env.TAVILY_API_KEY?.trim()) return;

  const candidates = [
    path.resolve(process.cwd(), '../../.env'),
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../../../.env'),
  ];

  for (const envPath of candidates) {
    loadDotenv({ path: envPath });
    if (process.env.TAVILY_API_KEY?.trim()) break;
  }
}

export function getCompanySettingsFromDb(raw: unknown): CompanySettings {
  ensureRootEnvLoaded();
  return parseCompanySettings(raw);
}

export function getResolvedTavilyApiKey(
  companySettings?: CompanySettings | null,
  agentRuntime?: AgentRuntimeConfig | null,
): string | null {
  ensureRootEnvLoaded();
  return resolveTavilyApiKey(companySettings, agentRuntime);
}

export const TAVILY_SEARCH_TIMEOUT_MS = Number(process.env.TAVILY_SEARCH_TIMEOUT_MS || 20000);
