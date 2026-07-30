import { resolveKnowledgeGraphMounts } from './knowledge-graph-config';

export type McpTransport = 'http' | 'stdio';

export interface McpServerAuthDefinition {
  envVar: string;
  optional?: boolean;
  header?: string;
  prefix?: string;
}

export interface McpServerDefinition {
  id: string;
  label: string;
  toolsetId?: string;
  transport: McpTransport;
  url?: string;
  urlEnvVar?: string;
  auth?: McpServerAuthDefinition;
  command?: string;
  args?: (ctx: { companyId: string }) => string[];
  env?: Record<string, string>;
  toolWhitelist?: string[];
  toolBlacklist?: string[];
}

export const MCP_SERVER_CATALOG: McpServerDefinition[] = [
  {
    id: 'buffer-mcp',
    label: 'Buffer',
    toolsetId: 'buffer',
    transport: 'http',
    url: 'https://mcp.buffer.com/mcp',
    urlEnvVar: 'BUFFER_MCP_URL',
    auth: { envVar: 'BUFFER_API_KEY' },
    toolWhitelist: [
      'get_account',
      'list_channels',
      'get_channel',
      'list_posts',
      'get_post',
      'list_ideas',
      'list_idea_groups',
      'create_idea',
      'create_post',
      'edit_post',
    ],
    toolBlacklist: [
      'delete_post',
      'get_aggregated_post_metrics',
      'introspect_schema',
      'execute_query',
      'execute_mutation',
    ],
  },
  {
    id: 'github-mcp',
    label: 'GitHub',
    transport: 'stdio',
    command: 'npx',
    args: () => ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN ?? '' },
  },
  {
    id: 'filesystem-local',
    label: 'Filesystem',
    transport: 'stdio',
    command: 'npx',
  },
  {
    id: 'memory-mcp-private',
    label: 'Private knowledge graph',
    transport: 'stdio',
    command: 'npx',
  },
  {
    id: 'memory-mcp-company',
    label: 'Company knowledge graph',
    transport: 'stdio',
    command: 'npx',
  },
];

const MCP_SERVER_BY_ID = new Map(MCP_SERVER_CATALOG.map((server) => [server.id, server]));

export function getMcpServerDefinition(serverId: string): McpServerDefinition | undefined {
  // Back-compat: legacy single memory-mcp id maps to private
  if (serverId === 'memory-mcp') return MCP_SERVER_BY_ID.get('memory-mcp-private');
  return MCP_SERVER_BY_ID.get(serverId);
}

export function getMcpServerForToolset(toolsetId: string): McpServerDefinition | undefined {
  return MCP_SERVER_CATALOG.find((server) => server.toolsetId === toolsetId);
}

/** Toolset ids that bridge to an MCP server (e.g. buffer, knowledge-graph). */
export function getMcpBridgedToolsetIds(): string[] {
  const ids = MCP_SERVER_CATALOG.map((server) => server.toolsetId).filter(
    (id): id is string => Boolean(id),
  );
  // knowledge-graph is bridged specially (private + company mounts)
  if (!ids.includes('knowledge-graph')) ids.push('knowledge-graph');
  return ids;
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
