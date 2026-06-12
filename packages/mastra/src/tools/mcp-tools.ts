import { MCPClient } from '@mastra/mcp';
import { ensureCompanyWorkspace, getCompanyWorkspaceDir } from '@tourbillon/shared/company-workspace';

// ─── Tier 3: Capability-gated MCP tools ────────────────────────────────────────────────────
//
// MCP servers are opt-in per agent via agent.mcpServerIds.
// Company policy is enforced via allowedMcpServerIds before calling this.

const mcpClientCache = new Map<string, MCPClient>();

async function getMCPClient(serverId: string, companyId: string): Promise<MCPClient | null> {
  const cacheKey = serverId === 'filesystem-local' ? `${serverId}:${companyId}` : serverId;
  if (mcpClientCache.has(cacheKey)) return mcpClientCache.get(cacheKey)!;

  let client: MCPClient | null = null;

  switch (serverId) {
    case 'searxng-local':
      client = new MCPClient({
        id: 'searxng-local',
        servers: {
          searxng: {
            url: new URL(process.env.SEARXNG_URL ?? 'http://localhost:8888/mcp'),
          },
        },
      });
      break;

    case 'filesystem-local': {
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
      break;
    }

    case 'github-mcp':
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

  mcpClientCache.set(cacheKey, client);
  return client;
}

export async function buildMCPTools(
  mcpServerIds: string[],
  companyId: string,
  allowedMcpServerIds: string[] = []
): Promise<Record<string, unknown>> {
  const tools: Record<string, unknown> = {};
  const allowed =
    allowedMcpServerIds.length > 0
      ? mcpServerIds.filter((id) => allowedMcpServerIds.includes(id))
      : mcpServerIds;

  for (const serverId of allowed) {
    const client = await getMCPClient(serverId, companyId);
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
