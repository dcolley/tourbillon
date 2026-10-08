/**
 * MCP tool loading for agent wakes / capabilities preview.
 * Server-only: imports Node-backed @tourbillon/shared/mcp-registry (mcp.json).
 */
import { MCPClient } from '@mastra/mcp';
import type { Agent as AgentRecord } from '@tourbillon/db';
import type { AgentRuntimeConfig, CompanySettings, McpServerDefinition } from '@tourbillon/shared';
import {
  checkToolEgressTarget,
  fetchWithToolEgress,
  isToolEgressBlockedError,
  isToolEgressRestricted,
  resolveToolEgressPolicy,
  toolEgressPolicyKey,
  type ToolEgressPolicy,
} from '@tourbillon/shared/tool-egress';
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

/**
 * fetch for an HTTP MCP server. With a tool egress allow-list set, every request and redirect hop
 * must stay on the list (fetchWithToolEgress), and a redirect to another origin drops the API key
 * and every configured server header; without one, plain fetch as before. A blocked hop
 * writes one server warning line with the MCP server name and the blocked host only (no path,
 * query or agent), then the error is rethrown.
 */
export function createMcpHttpFetch(
  apiKey: string | undefined,
  extraHeaders?: Record<string, string>,
  egressPolicy?: ToolEgressPolicy,
  serverName?: string,
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
    if (isToolEgressRestricted(egressPolicy)) {
      try {
        // Configured server headers may carry credentials: never re-send them to another origin.
        return await fetchWithToolEgress(url, { ...init, headers }, egressPolicy, {
          credentialHeaders: Object.keys(extraHeaders ?? {}),
        });
      } catch (err) {
        if (isToolEgressBlockedError(err)) {
          console.warn(
            `[mcp-tools] MCP server ${serverName ?? 'unknown'}: blocked outbound host ${err.host ?? 'unknown'} (not on the tool allow-list)`,
          );
        }
        throw err;
      }
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
  /** Tool egress policy; clients with different allow-lists are never shared. */
  egressPolicy?: ToolEgressPolicy;
}): string {
  const { serverId, companyId, urlKey, apiKey, egressPolicy } = options;
  const credential = apiKey ? createHash('sha256').update(apiKey).digest('hex') : 'none';
  const scope = serverId === 'memory-mcp-private' && urlKey ? `${companyId}:${urlKey}` : companyId;
  const egressKey = toolEgressPolicyKey(egressPolicy);
  const egress = egressKey ? `:egress-${createHash('sha256').update(egressKey).digest('hex').slice(0, 16)}` : '';
  return `${serverId}:${scope}:${credential}${egress}`;
}

export interface GetMcpClientOptions {
  companyId: string;
  urlKey?: string;
  apiKey?: string;
  egressPolicy?: ToolEgressPolicy;
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
  egressPolicy: ToolEgressPolicy | undefined,
): MCPClient | null {
  const url = resolveMcpServerUrl(serverId);
  if (!url) return null;

  return new MCPClient({
    id: serverId,
    servers: {
      [serverKeyForClient(serverId)]: {
        url,
        fetch: createMcpHttpFetch(apiKey, def.headers, egressPolicy, serverId),
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
  const { companyId, urlKey, apiKey, egressPolicy } = options;

  const cacheKey = mcpClientCacheKey({ serverId, companyId, urlKey, apiKey, egressPolicy });

  if (mcpClientCache.has(cacheKey)) return mcpClientCache.get(cacheKey)!;

  const def = getMcpServerDefinition(serverId);
  if (!def) return null;

  let client: MCPClient | null = null;

  if (isSpecialMcpServerId(serverId)) {
    client = await getSpecialStdioClient(serverId, options);
  } else if (def.transport === 'http') {
    client = getGenericHttpClient(serverId, def, apiKey, egressPolicy);
  } else if (def.transport === 'stdio') {
    client = getGenericStdioClient(serverId, def);
  }

  if (!client) return null;

  mcpClientCache.set(cacheKey, client);
  return client;
}

export { resolveAgentMcpServerIds, agentNeedsMcpTools };

/**
 * Host of an HTTP MCP server that the tool egress allow-list refuses, or null when allowed
 * (or not an HTTP server). A refused server is never connected.
 */
export function mcpServerEgressBlockedHost(
  serverId: string,
  def: McpServerDefinition,
  egressPolicy: ToolEgressPolicy,
): string | null {
  if (!isToolEgressRestricted(egressPolicy)) return null;
  if (isSpecialMcpServerId(serverId) || def.transport !== 'http') return null;
  const url = resolveMcpServerUrl(serverId);
  if (!url) return null;
  const decision = checkToolEgressTarget(egressPolicy, url.href);
  return decision.allowed ? null : (decision.host ?? 'unknown host');
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
  const allowed = resolveAgentMcpServerIds(agentRecord, {
    allowedMcpServerIds: options.allowedMcpServerIds,
    agentRuntime: runtimeConfig,
  });
  const egressPolicy = resolveToolEgressPolicy(companySettings, runtimeConfig);

  for (const serverId of allowed) {
    const def = getMcpServerDefinition(serverId);
    if (!def) continue;
    const blockedHost = mcpServerEgressBlockedHost(serverId, def, egressPolicy);
    if (blockedHost) {
      console.warn(`[mcp-tools] Skipping ${serverId}: host ${blockedHost} is not on the tool allow-list`);
      continue;
    }

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
      egressPolicy,
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
  const egressPolicy = resolveToolEgressPolicy(companySettings, runtimeConfig);

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

    const blockedHost = mcpServerEgressBlockedHost(serverId, def, egressPolicy);
    if (blockedHost) {
      results.push({ ...base, error: `Host ${blockedHost} is not on the outbound allow-list for agent tools` });
      continue;
    }

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
        egressPolicy,
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
