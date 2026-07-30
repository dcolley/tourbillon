import { MCPClient } from '@mastra/mcp';
import type { Agent as AgentRecord } from '@tourbillon/db';
import {
  getMcpServerDefinition,
  resolveMcpCredential,
  resolveMcpServerUrl,
  resolveAgentMcpServerIds,
  agentNeedsMcpTools,
  type AgentRuntimeConfig,
  type CompanySettings,
} from '@tourbillon/shared';
import {
  ensureAgentMemoryDir,
  ensureCompanyMemoryDir,
  ensureCompanyWorkspace,
  getAgentMemoryFilePath,
  getCompanyMemoryFilePath,
  getCompanyWorkspaceDir,
} from '@tourbillon/shared/company-workspace';
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

export interface GetMcpClientOptions {
  companyId: string;
  urlKey?: string;
  apiKey?: string;
}

async function getMCPClient(
  serverId: string,
  options: GetMcpClientOptions,
): Promise<MCPClient | null> {
  const { companyId, urlKey, apiKey } = options;

  const cacheKey =
    serverId === 'filesystem-local'
      ? `${serverId}:${companyId}`
      : serverId === 'memory-mcp-private' && urlKey
        ? `${serverId}:${companyId}:${urlKey}`
        : serverId === 'memory-mcp-company'
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
  } else if (serverId === 'memory-mcp-private') {
    if (!urlKey) return null;
    await ensureAgentMemoryDir(companyId, urlKey);
    const memoryFilePath = getAgentMemoryFilePath(companyId, urlKey);
    client = new MCPClient({
      id: `memory-mcp-private-${companyId}-${urlKey}`,
      servers: {
        memory_private: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-memory'],
          env: { MEMORY_FILE_PATH: memoryFilePath },
        },
      },
    });
  } else if (serverId === 'memory-mcp-company') {
    await ensureCompanyMemoryDir(companyId);
    const memoryFilePath = getCompanyMemoryFilePath(companyId);
    client = new MCPClient({
      id: `memory-mcp-company-${companyId}`,
      servers: {
        memory_company: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-memory'],
          env: { MEMORY_FILE_PATH: memoryFilePath },
        },
      },
    });
  }

  if (!client) return null;

  mcpClientCache.set(cacheKey, client);
  return client;
}

export { resolveAgentMcpServerIds, agentNeedsMcpTools };

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
  const allowed = resolveAgentMcpServerIds(agentRecord, {
    allowedMcpServerIds: options.allowedMcpServerIds,
    agentRuntime: runtimeConfig,
  });

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

    const client = await getMCPClient(serverId, {
      companyId: agentRecord.companyId,
      urlKey: agentRecord.urlKey,
      apiKey,
    });
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

export interface McpToolCatalogEntry {
  name: string;
  description?: string;
}

export interface McpServerToolCatalog {
  serverId: string;
  label: string;
  tools: McpToolCatalogEntry[];
  /** Registry defaults for UI when no agent policy.allow is stored. */
  toolWhitelist?: string[];
  toolBlacklist?: string[];
  error?: string;
}

export interface ListMcpToolsForAgentOptions {
  allowedMcpServerIds?: string[];
  companySettings?: CompanySettings | null;
  /** Preview unsaved toolset selection. */
  assignedToolsets?: string[];
  mcpServerIds?: string[];
  /** Preview unsaved knowledge-graph mounts. */
  knowledgeGraph?: AgentRuntimeConfig['knowledgeGraph'];
}

export async function listMcpToolsForAgent(
  agentRecord: AgentRecord,
  options: ListMcpToolsForAgentOptions = {},
): Promise<McpServerToolCatalog[]> {
  const companySettings = options.companySettings ?? null;
  const runtimeConfig = agentRecord.runtimeConfig as AgentRuntimeConfig;
  const previewRuntime: AgentRuntimeConfig =
    options.knowledgeGraph !== undefined
      ? { ...runtimeConfig, knowledgeGraph: options.knowledgeGraph }
      : runtimeConfig;

  const allowed = resolveAgentMcpServerIds(agentRecord, {
    allowedMcpServerIds: options.allowedMcpServerIds,
    assignedToolsets: options.assignedToolsets,
    mcpServerIds: options.mcpServerIds,
    agentRuntime: previewRuntime,
  });

  const results: McpServerToolCatalog[] = [];

  for (const serverId of allowed) {
    const def = getMcpServerDefinition(serverId);
    if (!def) {
      results.push({
        serverId,
        label: serverId,
        tools: [],
        error: 'Unknown MCP server id',
      });
      continue;
    }

    const base: McpServerToolCatalog = {
      serverId,
      label: def.label,
      tools: [],
      toolWhitelist: def.toolWhitelist,
      toolBlacklist: def.toolBlacklist,
    };

    let apiKey: string | undefined;
    if (def.auth) {
      const resolved = resolveMcpCredential({
        serverId,
        agentRuntime: runtimeConfig,
        companySettings,
      });
      if (resolved === null) {
        results.push({
          ...base,
          error: `Missing credentials for ${def.label} (configure API key)`,
        });
        continue;
      }
      apiKey = resolved || undefined;
    }

    try {
      const client = await getMCPClient(serverId, {
        companyId: agentRecord.companyId,
        urlKey: agentRecord.urlKey,
        apiKey,
      });
      if (!client) {
        results.push({ ...base, error: `Failed to connect to ${def.label}` });
        continue;
      }

      const clientTools = await client.listTools();
      const tools: McpToolCatalogEntry[] = Object.entries(clientTools).map(([name, tool]) => {
        const description =
          tool &&
          typeof tool === 'object' &&
          'description' in tool &&
          typeof (tool as { description?: unknown }).description === 'string'
            ? (tool as { description: string }).description
            : undefined;
        return { name, description };
      });

      results.push({ ...base, tools });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ ...base, error: message });
    }
  }

  return results;
}
