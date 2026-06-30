import type { AgentRuntimeConfig } from '@tourbillon/shared/types';
import type { McpServerDefinition } from '@tourbillon/shared/mcp-registry';

function matchesToolName(toolName: string, pattern: string): boolean {
  return toolName === pattern || toolName.endsWith(`_${pattern}`) || toolName.includes(pattern);
}

function isDenied(toolName: string, denyList: string[] | undefined): boolean {
  if (!denyList?.length) return false;
  return denyList.some((pattern) => matchesToolName(toolName, pattern));
}

function isAllowed(toolName: string, allowList: string[] | undefined): boolean {
  if (!allowList?.length) return true;
  return allowList.some((pattern) => matchesToolName(toolName, pattern));
}

export function filterMcpTools(
  tools: Record<string, unknown>,
  serverDef: McpServerDefinition,
  agentRuntime?: AgentRuntimeConfig | null,
): Record<string, unknown> {
  const policy = agentRuntime?.mcpToolPolicy?.[serverDef.id];
  const deny = [...(serverDef.toolBlacklist ?? []), ...(policy?.deny ?? [])];
  const allow = policy?.allow?.length ? policy.allow : serverDef.toolWhitelist;

  const filtered: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (isDenied(name, deny)) continue;
    if (!isAllowed(name, allow)) continue;
    filtered[name] = tool;
  }
  return filtered;
}
