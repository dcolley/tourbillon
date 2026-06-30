import { getMcpServerDefinition } from './mcp-registry';
import type { AgentRuntimeConfig, CompanySettings } from './types';

export interface McpCredentialContext {
  serverId: string;
  agentRuntime?: AgentRuntimeConfig | null;
  companySettings?: CompanySettings | null;
}

export function resolveMcpCredential(ctx: McpCredentialContext): string | null {
  const def = getMcpServerDefinition(ctx.serverId);
  if (!def?.auth) return null;

  const fromAgent = ctx.agentRuntime?.mcpCredentials?.[ctx.serverId]?.trim();
  if (fromAgent) return fromAgent;

  const fromCompany = ctx.companySettings?.mcpCredentials?.[ctx.serverId]?.trim();
  if (fromCompany) return fromCompany;

  const fromEnv = process.env[def.auth.envVar]?.trim();
  if (fromEnv) return fromEnv;

  if (def.auth.optional) return '';

  return null;
}

export function resolveMcpServerUrl(serverId: string): URL | null {
  const def = getMcpServerDefinition(serverId);
  if (!def?.url && !def?.urlEnvVar) return null;

  const raw = (def.urlEnvVar ? process.env[def.urlEnvVar]?.trim() : undefined) || def.url;
  if (!raw) return null;

  try {
    return new URL(raw);
  } catch {
    return null;
  }
}
