/**
 * MCP tool loading for agent wakes / capabilities preview.
 * Server-only: imports Node-backed @tourbillon/shared/mcp-registry (mcp.json).
 */
import { MCPClient } from '@mastra/mcp';
import type { Agent as AgentRecord } from '@tourbillon/db';
import type { AgentRuntimeConfig, CompanySettings, McpServerDefinition } from '@tourbillon/shared';
import {
  agentNeedsMcpTools,
  getMcpServerDefinition,
  isSpecialMcpServerId,
  resolveAgentMcpServerIds,
} from '@tourbillon/shared/mcp-registry';
import { resolveMcpServerUrl } from '@tourbillon/shared/mcp-credentials';
import { resolveVaultSecret } from '@tourbillon/shared/vault-credentials';
import {
  ensureAgentMemoryDir,
  ensureCompanyMemoryDir,
  ensureCompanyWorkspace,
  getAgentMemoryFilePath,
  getCompanyMemoryFilePath,
  getCompanyWorkspaceDir,
} from '@tourbillon/shared/company-workspace';
import { createHash } from 'node:crypto';
import { mcpServerToolNamespace } from '@tourbillon/shared/tool-permissions';
import { filterMcpTools } from './mcp-tool-filter';

const mcpClientCache = new Map<string, MCPClient>();

/** Test hook: serve a stand-in client for a cache key (see {@link mcpClientCacheKey}). */
export function primeMcpClientCacheForTests(key: string, client: { listTools(): Promise<Record<string, unknown>> } | null): void {
  if (client) mcpClientCache.set(key, client as unknown as MCPClient);
  else mcpClientCache.delete(key);
}

function buildHttpFetch(
  apiKey: string | undefined,
  extraHeaders?: Record<string, string>,
) {
  return async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (extraHeaders) {
      for (const [key, value] of Object.entries(extraHeaders)) {
        if (value) headers.set(key, value);
      }
    }
    if (apiKey) {
      headers.set('Authorization', `Bearer ${apiKey}`);
    }
    return fetch(url, { ...init, headers });
  };
}

function serverKeyForClient(serverId: string): string {
  return mcpServerToolNamespace(serverId);
}

/**
 * Client cache key: one client per company + server + credential. The credential is hashed
 * (never a raw key prefix), so two credentials that share a prefix never share a client.
 */
export function mcpClientCacheKey(options: {
  serverId: string;
  companyId: string;
  urlKey?: string;
  apiKey?: string;
}): string {
  const { serverId, companyId, urlKey, apiKey } = options;
  const credential = apiKey ? createHash('sha256').update(apiKey).digest('hex') : 'none';
  const scope = serverId === 'memory-mcp-private' && urlKey ? `${companyId}:${urlKey}` : companyId;
  return `${serverId}:${scope}:${credential}`;
}

export interface GetMcpClientOptions {
  companyId: string;
  urlKey?: string;
  apiKey?: string;
}

async function getSpecialStdioClient(
  serverId: string,
  options: GetMcpClientOptions,
): Promise<MCPClient | null> {
  const { companyId, urlKey } = options;

  if (serverId === 'filesystem-local') {
    await ensureCompanyWorkspace(companyId);
    const workspacePath = getCompanyWorkspaceDir(companyId);
    return new MCPClient({
      id: `filesystem-local-${companyId}`,
      servers: {
        [mcpServerToolNamespace('filesystem-local')]: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', workspacePath],
        },
      },
    });
  }

  if (serverId === 'memory-mcp-private') {
    if (!urlKey) return null;
    await ensureAgentMemoryDir(companyId, urlKey);
    const memoryFilePath = getAgentMemoryFilePath(companyId, urlKey);
    return new MCPClient({
      id: `memory-mcp-private-${companyId}-${urlKey}`,
      servers: {
        [mcpServerToolNamespace('memory-mcp-private')]: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-memory'],
          env: { MEMORY_FILE_PATH: memoryFilePath },
        },
      },
    });
  }

  if (serverId === 'memory-mcp-company') {
    await ensureCompanyMemoryDir(companyId);
    const memoryFilePath = getCompanyMemoryFilePath(companyId);
    return new MCPClient({
      id: `memory-mcp-company-${companyId}`,
      servers: {
        [mcpServerToolNamespace('memory-mcp-company')]: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-memory'],
          env: { MEMORY_FILE_PATH: memoryFilePath },
        },
      },
    });
  }

  return null;
}

function getGenericHttpClient(
  serverId: string,
  def: McpServerDefinition,
  apiKey: string | undefined,
): MCPClient | null {
  const url = resolveMcpServerUrl(serverId);
  if (!url) return null;

  return new MCPClient({
    id: serverId,
    servers: {
      [serverKeyForClient(serverId)]: {
        url,
        fetch: buildHttpFetch(apiKey, def.headers),
      },
    },
  });
}

function getGenericStdioClient(serverId: string, def: McpServerDefinition): MCPClient | null {
  if (!def.command) return null;

  const env =
    serverId === 'github-mcp'
      ? {
          ...def.env,
          GITHUB_PERSONAL_ACCESS_TOKEN:
            def.env?.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_TOKEN || '',
        }
      : def.env;

  return new MCPClient({
    id: serverId,
    servers: {
      [serverKeyForClient(serverId)]: {
        command: def.command,
        args: def.args ?? [],
        env,
      },
    },
  });
}

async function getMCPClient(
  serverId: string,
  options: GetMcpClientOptions,
): Promise<MCPClient | null> {
  const { companyId, urlKey, apiKey } = options;

  const cacheKey = mcpClientCacheKey({ serverId, companyId, urlKey, apiKey });

  if (mcpClientCache.has(cacheKey)) return mcpClientCache.get(cacheKey)!;

  const def = getMcpServerDefinition(serverId);
  if (!def) return null;

  let client: MCPClient | null = null;

  if (isSpecialMcpServerId(serverId)) {
    client = await getSpecialStdioClient(serverId, options);
  } else if (def.transport === 'http') {
    client = getGenericHttpClient(serverId, def, apiKey);
  } else if (def.transport === 'stdio') {
    client = getGenericStdioClient(serverId, def);
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
      const resolved = await resolveVaultSecret({
        companyId: agentRecord.companyId,
        serverId,
        agentId: agentRecord.id,
        agentRuntime: runtimeConfig,
        companySettings,
      });
      if (resolved === null) continue;
      if (typeof resolved === 'string') {
        apiKey = resolved;
      } else {
        apiKey = resolved.accessToken;
      }
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
      const resolved = await resolveVaultSecret({
        companyId: agentRecord.companyId,
        serverId,
        agentId: agentRecord.id,
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
      if (typeof resolved === 'string') {
        apiKey = resolved;
      } else {
        apiKey = resolved.accessToken;
      }
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
