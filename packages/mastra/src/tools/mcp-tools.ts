import { MCPClient } from '@mastra/mcp';

// ─── Tier 3: Capability-gated MCP tools ────────────────────────────────────────────────────
//
// MCP servers are opt-in per agent via agent.mcpServerIds.
// Company policy is enforced in the heartbeat worker before calling this.

const mcpClientCache = new Map<string, MCPClient>();

function getMCPClient(serverId: string): MCPClient | null {
  if (mcpClientCache.has(serverId)) return mcpClientCache.get(serverId)!;

  let client: MCPClient | null = null;

  switch (serverId) {
    case 'searxng-local':
      // Local SearXNG instance — fully open-source, no API key
      client = new MCPClient({
        id: 'searxng-local',
        servers: {
          searxng: {
            url: new URL(process.env.SEARXNG_URL ?? 'http://localhost:8888/mcp'),
          },
        },
      });
      break;

    case 'filesystem-local':
      // Local filesystem MCP server — scoped to agent workspace
      client = new MCPClient({
        id: 'filesystem-local',
        servers: {
          filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
          },
        },
      });
      break;

    case 'github-mcp':
      // GitHub MCP — requires GITHUB_TOKEN env var
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
      break;

    default:
      return null;
  }

  mcpClientCache.set(serverId, client);
  return client;
}

export async function buildMCPTools(
  mcpServerIds: string[],
  _companyId: string
): Promise<Record<string, unknown>> {
  const tools: Record<string, unknown> = {};

  for (const serverId of mcpServerIds) {
    const client = getMCPClient(serverId);
    if (!client) continue;
    try {
      const serverTools = await client.getTools();
      Object.assign(tools, serverTools);
    } catch (err) {
      console.warn(`[mcp-tools] Failed to load tools from ${serverId}:`, err);
    }
  }

  return tools;
}
