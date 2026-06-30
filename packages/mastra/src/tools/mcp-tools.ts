import { MCPClient } from '@mastra/mcp';
import type { Agent as AgentRecord } from '@tourbillon/db';
import {
  getMcpServerDefinition,
  getMcpServerForToolset,
  resolveMcpCredential,
  resolveMcpServerUrl,
  type AgentRuntimeConfig,
  type CompanySettings,
} from '@tourbillon/shared';
import { ensureCompanyWorkspace, getCompanyWorkspaceDir } from '@tourbillon/shared/company-workspace';
import { filterMcpTools } from './mcp-tool-filter';

const mcpClientCache = new Map<string, MCPClient>();

function buildHttpFetch(apiKey: string | undefined) {
  return async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (apiKey) {
      headers.set('Authorization', `Bearer ${apiKey}`);
    }
    return fetch(url, { ...init, headers });
  };
}

async function getMCPClient(
  serverId: string,
  companyId: string,
  apiKey?: string,
): Promise<MCPClient | null> {
  const cacheKey =
    serverId === 'filesystem-local'
      ? `${serverId}:${companyId}`
      : serverId === 'buffer-mcp' && apiKey
        ? `${serverId}:${apiKey.slice(0, 8)}`
        : serverId;

  if (mcpClientCache.has(cacheKey)) return mcpClientCache.get(cacheKey)!;

  const def = getMcpServerDefinition(serverId);
  if (!def) return null;

  let client: MCPClient | null = null;

  if (def.transport === 'http') {
    const url = resolveMcpServerUrl(serverId);
    if (!url) return null;

    client = new MCPClient({
      id: serverId,
      servers: {
        [serverId.replace(/-mcp$/, '')]: {
          url,
          fetch: buildHttpFetch(apiKey || undefined),
        },
      },
    });
  } else if (serverId === 'filesystem-local') {
    await ensureCompanyWorkspace(companyId);
    const workspacePath = getCompanyWorkspaceDir(companyId);
    client = new MCPClient({
      id: `filesystem-local-${companyId}`,
      servers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', workspacePath],
        },
      },
    });
  } else if (serverId === 'github-mcp') {
    client = new MCPClient({
      id: 'github-mcp',
      servers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN ?? '' },
        },
      },
    });
  }

  if (!client) return null;

  mcpClientCache.set(cacheKey, client);
  return client;
}

export interface BuildMCPToolsOptions {
  allowedMcpServerIds?: string[];
  companySettings?: CompanySettings | null;
}

export async function buildMCPTools(
  agentRecord: AgentRecord,
  options: BuildMCPToolsOptions = {},
): Promise<Record<string, unknown>> {
  const tools: Record<string, unknown> = {};
  const companySettings = options.companySettings ?? null;
  const runtimeConfig = agentRecord.runtimeConfig as AgentRuntimeConfig;
  const allowedMcpServerIds = options.allowedMcpServerIds ?? [];

  const serverIds = new Set<string>();

  const bufferDef = getMcpServerForToolset('buffer');
  if (bufferDef && agentRecord.assignedToolsets?.includes('buffer')) {
    serverIds.add(bufferDef.id);
  }

  for (const serverId of agentRecord.mcpServerIds ?? []) {
    if (serverId === 'searxng-local') continue;
    serverIds.add(serverId);
  }

  const allowed =
    allowedMcpServerIds.length > 0
      ? [...serverIds].filter((id) => allowedMcpServerIds.includes(id))
      : [...serverIds];

  for (const serverId of allowed) {
    const def = getMcpServerDefinition(serverId);
    if (!def) continue;

    let apiKey: string | undefined;
    if (def.auth) {
      const resolved = resolveMcpCredential({
        serverId,
        agentRuntime: runtimeConfig,
        companySettings,
      });
      if (resolved === null) continue;
      apiKey = resolved || undefined;
    }

    const client = await getMCPClient(serverId, agentRecord.companyId, apiKey);
    if (!client) continue;

    try {
      const clientTools = await client.listTools();
      const filtered = filterMcpTools(clientTools, def, runtimeConfig);
      Object.assign(tools, filtered);
    } catch (err) {
      console.warn(`[mcp-tools] Failed to load tools from ${serverId}:`, err);
    }
  }

  return tools;
}
