import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import {
  parseCompanySettings,
  resolveSearxngAuth,
  resolveSearxngBaseUrl,
  type CompanySettings,
} from '@tourbillon/shared';
import type { AgentRuntimeConfig } from '@tourbillon/shared';

let rootEnvLoaded = false;

function ensureRootEnvLoaded(): void {
  if (rootEnvLoaded) return;
  rootEnvLoaded = true;

  if (process.env.SEARXNG_URL?.trim()) return;

  const candidates = [
    path.resolve(process.cwd(), '../../.env'),
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../../../.env'),
  ];

  for (const envPath of candidates) {
    loadDotenv({ path: envPath });
    if (process.env.SEARXNG_URL?.trim()) break;
  }
}

export function getCompanySettingsFromDb(raw: unknown): CompanySettings {
  ensureRootEnvLoaded();
  return parseCompanySettings(raw);
}

export function getResolvedSearxngBaseUrl(
  companySettings?: CompanySettings | null,
  agentRuntime?: AgentRuntimeConfig | null,
): string | null {
  ensureRootEnvLoaded();
  return resolveSearxngBaseUrl(companySettings, agentRuntime);
}

export function getResolvedSearxngAuth(
  companySettings?: CompanySettings | null,
  agentRuntime?: AgentRuntimeConfig | null,
): string | null {
  ensureRootEnvLoaded();
  return resolveSearxngAuth(companySettings, agentRuntime);
}

export const SEARXNG_SEARCH_TIMEOUT_MS = Number(process.env.SEARXNG_SEARCH_TIMEOUT_MS || 20000);
