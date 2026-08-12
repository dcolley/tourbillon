import type { McpServerDefinition } from './mcp-types';

/** First-party servers declared in code (toolset bridges + special client wiring). */
export const MCP_BUILTIN_CATALOG: McpServerDefinition[] = [
  {
    id: 'buffer-mcp',
    label: 'Buffer',
    toolsetId: 'buffer',
    transport: 'http',
    url: 'https://mcp.buffer.com/mcp',
    urlEnvVar: 'BUFFER_MCP_URL',
    auth: { envVar: 'BUFFER_API_KEY' },
    source: 'builtin',
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
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN ?? '' },
    source: 'builtin',
  },
  {
    id: 'filesystem-local',
    label: 'Filesystem',
    transport: 'stdio',
    command: 'npx',
    source: 'builtin',
  },
  {
    id: 'memory-mcp-private',
    label: 'Private knowledge graph',
    transport: 'stdio',
    command: 'npx',
    source: 'builtin',
  },
  {
    id: 'memory-mcp-company',
    label: 'Company knowledge graph',
    transport: 'stdio',
    command: 'npx',
    source: 'builtin',
  },
];

/** @deprecated Use MCP_BUILTIN_CATALOG or listMcpServerDefinitions() */
export const MCP_SERVER_CATALOG = MCP_BUILTIN_CATALOG;

const SPECIAL_STDIO_SERVER_IDS = new Set([
  'filesystem-local',
  'memory-mcp-private',
  'memory-mcp-company',
]);

export function isSpecialMcpServerId(serverId: string): boolean {
  return SPECIAL_STDIO_SERVER_IDS.has(serverId);
}

/**
 * Toolset ids that bridge to an MCP server.
 * Client-safe: derived from builtins only (no mcp.json / fs).
 */
export function getMcpBridgedToolsetIds(): string[] {
  const ids = MCP_BUILTIN_CATALOG.map((server) => server.toolsetId).filter(
    (id): id is string => Boolean(id),
  );
  if (!ids.includes('knowledge-graph')) ids.push('knowledge-graph');
  return [...new Set(ids)];
}

export function getBuiltinMcpServerForToolset(
  toolsetId: string,
): McpServerDefinition | undefined {
  return MCP_BUILTIN_CATALOG.find((server) => server.toolsetId === toolsetId);
}
