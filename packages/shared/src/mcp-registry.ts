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
];

const MCP_SERVER_BY_ID = new Map(MCP_SERVER_CATALOG.map((server) => [server.id, server]));

export function getMcpServerDefinition(serverId: string): McpServerDefinition | undefined {
  return MCP_SERVER_BY_ID.get(serverId);
}

export function getMcpServerForToolset(toolsetId: string): McpServerDefinition | undefined {
  return MCP_SERVER_CATALOG.find((server) => server.toolsetId === toolsetId);
}
