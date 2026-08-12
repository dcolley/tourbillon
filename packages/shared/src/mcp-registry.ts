import { resolveKnowledgeGraphMounts } from './knowledge-graph-config';
import { loadMcpJsonConfig } from './mcp-config';
import {
  MCP_BUILTIN_CATALOG,
  MCP_SERVER_CATALOG,
  getBuiltinMcpServerForToolset,
  getMcpBridgedToolsetIds,
  isSpecialMcpServerId,
} from './mcp-builtin-catalog';
import type { McpServerDefinition } from './mcp-types';

export type {
  McpTransport,
  McpServerAuthDefinition,
  McpServerDefinition,
} from './mcp-types';
export {
  MCP_BUILTIN_CATALOG,
  MCP_SERVER_CATALOG,
  getMcpBridgedToolsetIds,
  isSpecialMcpServerId,
} from './mcp-builtin-catalog';

let mergedCache: McpServerDefinition[] | null = null;
let mergedById: Map<string, McpServerDefinition> | null = null;

function mergeBuiltinAndFileCatalogs(): McpServerDefinition[] {
  const byId = new Map<string, McpServerDefinition>();

  for (const server of MCP_BUILTIN_CATALOG) {
    byId.set(server.id, { ...server, source: server.source ?? 'builtin' });
  }

  for (const fileServer of loadMcpJsonConfig()) {
    const existing = byId.get(fileServer.id);
    if (existing) {
      // File wins for connection fields; keep builtin toolset/auth/filters when present.
      byId.set(fileServer.id, {
        ...existing,
        ...fileServer,
        toolsetId: existing.toolsetId ?? fileServer.toolsetId,
        auth: fileServer.auth ?? existing.auth,
        toolWhitelist: fileServer.toolWhitelist ?? existing.toolWhitelist,
        toolBlacklist: fileServer.toolBlacklist ?? existing.toolBlacklist,
        source: 'file',
      });
    } else {
      byId.set(fileServer.id, fileServer);
    }
  }

  return [...byId.values()];
}

function ensureRegistry(): Map<string, McpServerDefinition> {
  if (!mergedById) {
    mergedCache = mergeBuiltinAndFileCatalogs();
    mergedById = new Map(mergedCache.map((server) => [server.id, server]));
  }
  return mergedById;
}

/** Reset merged catalog (tests / after config change in-process). */
export function resetMcpRegistryCache(): void {
  mergedCache = null;
  mergedById = null;
}

export function listMcpServerDefinitions(): McpServerDefinition[] {
  ensureRegistry();
  return mergedCache ?? [];
}

/**
 * Servers an agent may toggle via mcpServerIds (excludes toolset-only specials that
 * are always bridged: memory mounts stay toolset-driven; filesystem is not agent-toggleable here).
 */
export function listToggleableMcpServerDefinitions(
  allowedMcpServerIds: string[] = [],
): McpServerDefinition[] {
  const all = listMcpServerDefinitions().filter((server) => {
    if (server.id === 'memory-mcp-private' || server.id === 'memory-mcp-company') return false;
    if (server.id === 'filesystem-local') return false;
    return true;
  });

  if (allowedMcpServerIds.length === 0) return all;

  return all.filter((server) => {
    if (allowedMcpServerIds.includes(server.id)) return true;
    if (
      (server.id === 'memory-mcp-private' || server.id === 'memory-mcp-company') &&
      allowedMcpServerIds.includes('memory-mcp')
    ) {
      return true;
    }
    return false;
  });
}

export function getMcpServerDefinition(serverId: string): McpServerDefinition | undefined {
  const byId = ensureRegistry();
  // Back-compat: legacy single memory-mcp id maps to private
  if (serverId === 'memory-mcp') return byId.get('memory-mcp-private');
  return byId.get(serverId);
}

export function getMcpServerForToolset(toolsetId: string): McpServerDefinition | undefined {
  return (
    listMcpServerDefinitions().find((server) => server.toolsetId === toolsetId) ??
    getBuiltinMcpServerForToolset(toolsetId)
  );
}

export interface ResolveAgentMcpServerIdsInput {
  assignedToolsets?: string[] | null;
  mcpServerIds?: string[] | null;
  /** Agent runtime JSON (may be untyped from DB). */
  runtimeConfig?: unknown;
}

export interface ResolveAgentMcpServerIdsOptions {
  allowedMcpServerIds?: string[];
  /** Override assignedToolsets (e.g. unsaved UI preview). */
  assignedToolsets?: string[];
  /** Override mcpServerIds. */
  mcpServerIds?: string[];
  agentRuntime?: unknown;
}

/** Union of toolset-bridged MCP servers + agent mcpServerIds, intersected with company allowlist. */
export function resolveAgentMcpServerIds(
  agent: ResolveAgentMcpServerIdsInput,
  options: ResolveAgentMcpServerIdsOptions = {},
): string[] {
  const toolsets = options.assignedToolsets ?? agent.assignedToolsets ?? [];
  const mcpServerIds = options.mcpServerIds ?? agent.mcpServerIds ?? [];
  const allowedMcpServerIds = options.allowedMcpServerIds ?? [];
  const runtime = (options.agentRuntime ?? agent.runtimeConfig ?? null) as {
    knowledgeGraph?: { private?: boolean; company?: boolean };
  } | null;

  const serverIds = new Set<string>();

  for (const toolsetId of toolsets) {
    if (toolsetId === 'knowledge-graph') {
      const mounts = resolveKnowledgeGraphMounts(runtime);
      if (mounts.private) serverIds.add('memory-mcp-private');
      if (mounts.company) serverIds.add('memory-mcp-company');
      continue;
    }
    const def = getMcpServerForToolset(toolsetId);
    if (def) serverIds.add(def.id);
  }

  for (const serverId of mcpServerIds) {
    if (serverId === 'searxng-local') continue;
    if (serverId === 'memory-mcp') {
      serverIds.add('memory-mcp-private');
      continue;
    }
    serverIds.add(serverId);
  }

  if (allowedMcpServerIds.length > 0) {
    return [...serverIds].filter((id) => {
      if (allowedMcpServerIds.includes(id)) return true;
      // Allow new ids if legacy memory-mcp was allowlisted
      if (
        (id === 'memory-mcp-private' || id === 'memory-mcp-company') &&
        allowedMcpServerIds.includes('memory-mcp')
      ) {
        return true;
      }
      return false;
    });
  }
  return [...serverIds];
}

export function agentNeedsMcpTools(agent: ResolveAgentMcpServerIdsInput): boolean {
  return resolveAgentMcpServerIds(agent).length > 0;
}
