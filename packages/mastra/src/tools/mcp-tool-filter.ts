import type { AgentRuntimeConfig } from '@tourbillon/shared/types';
import type { McpServerDefinition } from '@tourbillon/shared/mcp-types';

function matchesToolName(toolName: string, pattern: string): boolean {
  return toolName === pattern || toolName.endsWith(`_${pattern}`) || toolName.includes(pattern);
}

function isDenied(toolName: string, denyList: string[] | undefined): boolean {
  if (!denyList?.length) return false;
  return denyList.some((pattern) => matchesToolName(toolName, pattern));
}

/** `undefined` = no allow filter; `[]` = allow none; non-empty = allow matching names. */
function isAllowed(toolName: string, allowList: string[] | undefined): boolean {
  if (allowList === undefined) return true;
  if (allowList.length === 0) return false;
  return allowList.some((pattern) => matchesToolName(toolName, pattern));
}

export function filterMcpTools(
  tools: Record<string, unknown>,
  serverDef: McpServerDefinition,
  agentRuntime?: AgentRuntimeConfig | null,
): Record<string, unknown> {
  const policy =
    agentRuntime?.mcpToolPolicy?.[serverDef.id] ??
    (serverDef.id === 'memory-mcp-private'
      ? agentRuntime?.mcpToolPolicy?.['memory-mcp']
      : undefined);
  const deny = [...(serverDef.toolBlacklist ?? []), ...(policy?.deny ?? [])];
  const allow = policy?.allow !== undefined ? policy.allow : serverDef.toolWhitelist;

  const filtered: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (isDenied(name, deny)) continue;
    if (!isAllowed(name, allow)) continue;
    filtered[name] = tool;
  }
  return filtered;
}
