import type { AgentRuntimeConfig } from '@tourbillon/shared/types';
import type { McpServerDefinition } from '@tourbillon/shared/mcp-types';
import { isMcpToolNameAllowed, resolveMcpToolPolicy } from '@tourbillon/shared/tool-permissions';

/** Registry defaults + agent `mcpToolPolicy`; the live tool permission gate uses the same check. */
export function filterMcpTools(
  tools: Record<string, unknown>,
  serverDef: McpServerDefinition,
  agentRuntime?: AgentRuntimeConfig | null,
): Record<string, unknown> {
  const policy = resolveMcpToolPolicy(serverDef, agentRuntime);
  const filtered: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!isMcpToolNameAllowed(name, policy)) continue;
    filtered[name] = tool;
  }
  return filtered;
}
