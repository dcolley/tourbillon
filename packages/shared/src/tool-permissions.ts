/**
 * Tool permission manifest + pure allow-list resolution.
 *
 * `resolveAllowedToolNames` is the single source of truth for which tools an agent may hold.
 * Agent tool assembly (`assembleAgentTools`) and the live call-time permission gate both use it,
 * so the tools an agent is built with and the tools it may call cannot drift apart.
 *
 * Pure: no I/O. MCP server definitions are resolved by the caller and passed in.
 */
import type { AgentRuntimeConfig, CompanySettings } from './types';
import { isSearxngConfigured, isTavilyConfigured } from './company-settings';
import { resolveAssignedTools } from './tool-catalog';

export type ToolSurface = 'heartbeat' | 'harness' | 'chat';

/** Universal tools every agent holds (exposed under the key `${id}Tool`). */
export const CONTROL_PLANE_TOOL_IDS = [
  'getDateTime',
  'getIdentity',
  'getInbox',
  'checkoutIssue',
  'getHeartbeatContext',
  'getComments',
  'updateIssue',
  'search',
  'listWorkspaceFiles',
  'readWorkspaceFile',
  'writeWorkspaceFile',
  'deleteWorkspaceFile',
  'createSubtask',
  'sendToAgent',
  'getMessages',
  // skills
  'listSkills',
  'getSkill',
  // discovery
  'listTools',
  'getToolDetails',
] as const;

/** Control-plane tool removed when agent DMs are disabled (`runtimeConfig.mail.enabled === false`). */
export const MAIL_SEND_TOOL_ID = 'sendToAgent';

export const SEARXNG_TOOLSET_TOOL_IDS = ['searxngSearch', 'searxngNewsSearch'] as const;
export const TAVILY_TOOLSET_TOOL_IDS = ['webSearchTavily'] as const;
export const NITTER_TOOLSET_TOOL_IDS = ['nitterSearchTweets', 'nitterFeedUser', 'nitterSearchUsers'] as const;

const ROSTER_TOOL_IDS = ['listAgents', 'createAgent'] as const;

/** Boolean toolsets → tool ids (exposed under the key `${id}Tool`). */
export const ROLE_TOOLSET_TOOL_IDS: Readonly<Record<string, readonly string[]>> = {
  roster: ROSTER_TOOL_IDS,
  'agent-management': ROSTER_TOOL_IDS, // legacy alias
  comments: ['addComment'],
  approvals: ['createApproval', 'listApprovals', 'getApproval'],
  'web-search': SEARXNG_TOOLSET_TOOL_IDS,
  'web-search-tavily': TAVILY_TOOLSET_TOOL_IDS,
  nitter: NITTER_TOOLSET_TOOL_IDS,
};

/** Tools added by Mastra Memory (working memory / observational-memory recall). */
export const MASTRA_MEMORY_TOOL_NAMES = ['updateWorkingMemory', 'setWorkingMemory', 'recall'] as const;

/** AgentController built-in task tools (harness + dashboard chat controllers). */
export const CONTROLLER_TASK_TOOL_NAMES = ['task_write', 'task_update', 'task_complete', 'task_check'] as const;

/** Mastra workspace tools (sandbox file/exec), only with the code-execution toolset. */
export const WORKSPACE_TOOL_NAME_PREFIX = 'mastra_workspace_';

export const CODE_EXECUTION_TOOLSET_ID = 'code-execution';

/** Static tool record key for a tool id (legacy naming). */
export function toolKeyForId(toolId: string): string {
  return `${toolId}Tool`;
}

/** Namespace prefix MCP clients use for a server's tools (`${prefix}_${tool}`). */
export function mcpServerToolNamespace(serverId: string): string {
  if (serverId === 'filesystem-local') return 'filesystem';
  if (serverId === 'memory-mcp-private' || serverId === 'memory-mcp') return 'memory_private';
  if (serverId === 'memory-mcp-company') return 'memory_company';
  return serverId.replace(/-mcp$/, '').replace(/-/g, '_') || serverId;
}

export interface McpToolPolicyServerLike {
  id: string;
  toolWhitelist?: string[];
  toolBlacklist?: string[];
}

export interface McpToolPolicy {
  deny: string[];
  /** `undefined` = no allow filter; `[]` = allow none; non-empty = allow matching names. */
  allow: string[] | undefined;
  /** Server tool namespace (`${namespace}_${tool}`); lets patterns name the bare tool. */
  namespace?: string;
}

/** Registry defaults + per-agent `mcpToolPolicy` for one server. */
export function resolveMcpToolPolicy(
  serverDef: McpToolPolicyServerLike,
  agentRuntime?: AgentRuntimeConfig | null,
): McpToolPolicy {
  const policy =
    agentRuntime?.mcpToolPolicy?.[serverDef.id] ??
    (serverDef.id === 'memory-mcp-private' ? agentRuntime?.mcpToolPolicy?.['memory-mcp'] : undefined);
  return {
    deny: [...(serverDef.toolBlacklist ?? []), ...(policy?.deny ?? [])],
    allow: policy?.allow !== undefined ? policy.allow : serverDef.toolWhitelist,
    namespace: mcpServerToolNamespace(serverDef.id),
  };
}

/**
 * Exact MCP tool name match. A pattern names either the full exposed tool name
 * (`github_create_issue`, as stored by the capabilities form) or the bare tool name under the
 * server's namespace (`create_issue`, as in registry white/blacklists). No prefix, suffix or
 * substring matching: `get_post` does not match `buffer_get_post_metrics`.
 */
export function mcpToolNameMatchesPattern(toolName: string, pattern: string, namespace?: string): boolean {
  if (!pattern) return false;
  if (toolName === pattern) return true;
  return namespace !== undefined && namespace.length > 0 && toolName === `${namespace}_${pattern}`;
}

/** Same name matching MCP tool loading uses (deny wins; then allow filter). */
export function isMcpToolNameAllowed(toolName: string, policy: McpToolPolicy): boolean {
  const matches = (pattern: string) => mcpToolNameMatchesPattern(toolName, pattern, policy.namespace);
  if (policy.deny.some(matches)) return false;
  if (policy.allow === undefined) return true;
  if (policy.allow.length === 0) return false;
  return policy.allow.some(matches);
}

/**
 * The MCP namespace an exposed tool name belongs to: the longest namespace `ns` with the name
 * starting `${ns}_`. Longest wins so a server namespaced `acme` never claims tools of a server
 * namespaced `acme_admin`. Returns null when no namespace matches.
 */
export function owningMcpNamespace(toolName: string, namespaces: Iterable<string>): string | null {
  let owner: string | null = null;
  for (const ns of namespaces) {
    if (!ns || !toolName.startsWith(`${ns}_`) || toolName.length === ns.length + 1) continue;
    if (owner === null || ns.length > owner.length) owner = ns;
  }
  return owner;
}

const BROWSER_OR_COMPUTER_TOKEN = /(^|[_\-.:])(browser|computer|takeover)([_\-.:]|$)/i;

/** Browser / computer-use / takeover tools are denied by default (no capability exists yet). */
export function isBrowserOrComputerToolName(name: string): boolean {
  return BROWSER_OR_COMPUTER_TOKEN.test(name);
}

export interface ToolPermissionAgentLike {
  role: string;
  assignedToolsets?: string[] | null;
  runtimeConfig?: unknown;
}

export interface ToolPermissionCompanyLike {
  settings?: CompanySettings | null;
}

export interface ResolveAllowedToolNamesOptions {
  /** MCP servers this agent may use (already intersected with the company allow-list). */
  mcpServers?: McpToolPolicyServerLike[];
  /**
   * Ids of every registered MCP server (allowed or not). Used only to decide which server owns
   * a tool name, so an allowed server's namespace cannot claim another server's tools.
   */
  knownMcpServerIds?: string[];
}

export type ToolExclusionReason = 'mail_disabled' | 'web_search_not_configured' | 'not_in_toolset';

export interface AllowedMcpServer {
  serverId: string;
  namespace: string;
  policy: McpToolPolicy;
}

export interface AllowedToolNames {
  /** Ordered static tool ids (control-plane → toolsets → assignable). */
  staticToolIds: string[];
  /** Static ids and their record keys. */
  staticNames: Set<string>;
  /** Known static tools that are not allowed for this agent, with why. */
  excluded: Map<string, ToolExclusionReason>;
  workspace: boolean;
  mcpServers: AllowedMcpServer[];
  /** Namespaces of every known MCP server (allowed ones included), for tool-name ownership. */
  mcpNamespaces: Set<string>;
}

let knownStaticIds: Set<string> | null = null;

function allKnownStaticIds(): Set<string> {
  if (!knownStaticIds) {
    knownStaticIds = new Set<string>(CONTROL_PLANE_TOOL_IDS);
    for (const ids of Object.values(ROLE_TOOLSET_TOOL_IDS)) for (const id of ids) knownStaticIds.add(id);
  }
  return knownStaticIds;
}

/**
 * Resolve the tools an agent may hold/call. Pure.
 * Static tools: control-plane (sendToAgent only when mail is enabled), boolean toolsets
 * (web search only when configured), granular assignable tools. Plus Mastra built-ins
 * (memory, workspace with code execution) and MCP tools by allowed server + tool policy.
 */
export function resolveAllowedToolNames(
  agent: ToolPermissionAgentLike,
  company: ToolPermissionCompanyLike | null | undefined,
  options: ResolveAllowedToolNamesOptions = {},
): AllowedToolNames {
  const runtimeConfig = (agent.runtimeConfig ?? {}) as AgentRuntimeConfig;
  const companySettings = company?.settings ?? null;
  const toolsets = agent.assignedToolsets ?? [];
  const ordered: string[] = [];
  const seen = new Set<string>();
  const excluded = new Map<string, ToolExclusionReason>();
  const add = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    ordered.push(id);
  };

  const mailEnabled = runtimeConfig.mail?.enabled ?? true;
  for (const id of CONTROL_PLANE_TOOL_IDS) {
    if (id === MAIL_SEND_TOOL_ID && !mailEnabled) {
      excluded.set(id, 'mail_disabled');
      continue;
    }
    add(id);
  }

  const searxngOk = isSearxngConfigured(companySettings, runtimeConfig);
  const tavilyOk = isTavilyConfigured(companySettings, runtimeConfig);
  const searxngIds = new Set<string>(SEARXNG_TOOLSET_TOOL_IDS);
  const tavilyIds = new Set<string>(TAVILY_TOOLSET_TOOL_IDS);
  for (const toolsetId of toolsets) {
    if (toolsetId === 'planning') continue;
    const ids = ROLE_TOOLSET_TOOL_IDS[toolsetId];
    if (!ids) continue;
    for (const id of ids) {
      if ((searxngIds.has(id) && !searxngOk) || (tavilyIds.has(id) && !tavilyOk)) {
        excluded.set(id, 'web_search_not_configured');
        continue;
      }
      add(id);
    }
  }
  // Search tools reachable only via toolsets; record why they are off when unconfigured.
  for (const id of [...SEARXNG_TOOLSET_TOOL_IDS, ...TAVILY_TOOLSET_TOOL_IDS]) {
    if (seen.has(id) || excluded.has(id)) continue;
    const configured = searxngIds.has(id) ? searxngOk : tavilyOk;
    if (!configured) excluded.set(id, 'web_search_not_configured');
  }

  for (const id of resolveAssignedTools({
    role: agent.role,
    assignedToolsets: agent.assignedToolsets,
    runtimeConfig,
  })) {
    add(id);
  }

  for (const id of allKnownStaticIds()) {
    if (!seen.has(id) && !excluded.has(id)) excluded.set(id, 'not_in_toolset');
  }

  const staticNames = new Set<string>();
  for (const id of ordered) {
    staticNames.add(id);
    staticNames.add(toolKeyForId(id));
  }

  const mcpServers: AllowedMcpServer[] = (options.mcpServers ?? []).map((def) => ({
    serverId: def.id,
    namespace: mcpServerToolNamespace(def.id),
    policy: resolveMcpToolPolicy(def, runtimeConfig),
  }));

  const mcpNamespaces = new Set<string>(mcpServers.map((server) => server.namespace));
  for (const id of options.knownMcpServerIds ?? []) mcpNamespaces.add(mcpServerToolNamespace(id));

  return {
    staticToolIds: ordered,
    staticNames,
    excluded,
    workspace: toolsets.includes(CODE_EXECUTION_TOOLSET_ID),
    mcpServers,
    mcpNamespaces,
  };
}

export type ToolNameCategory = 'static' | 'memory' | 'controller' | 'workspace' | 'mcp';

export type ToolNameDecision =
  | { allowed: true; category: ToolNameCategory }
  | {
      allowed: false;
      reason:
        | ToolExclusionReason
        | 'browser_tools_disabled'
        | 'mcp_policy_denied'
        | 'not_allowed';
    };

const MEMORY_NAMES = new Set<string>(MASTRA_MEMORY_TOOL_NAMES);
const CONTROLLER_TASK_NAMES = new Set<string>(CONTROLLER_TASK_TOOL_NAMES);

function evaluateOneName(
  allowed: AllowedToolNames,
  name: string,
  surface: ToolSurface,
): ToolNameDecision {
  if (isBrowserOrComputerToolName(name)) return { allowed: false, reason: 'browser_tools_disabled' };
  if (allowed.staticNames.has(name)) return { allowed: true, category: 'static' };
  if (MEMORY_NAMES.has(name)) return { allowed: true, category: 'memory' };
  if (CONTROLLER_TASK_NAMES.has(name) && surface !== 'heartbeat') {
    return { allowed: true, category: 'controller' };
  }
  if (name.startsWith(WORKSPACE_TOOL_NAME_PREFIX)) {
    return allowed.workspace
      ? { allowed: true, category: 'workspace' }
      : { allowed: false, reason: 'not_in_toolset' };
  }

  // MCP: the owning namespace is decided over every known server (longest match), then only
  // allowed servers with exactly that namespace are consulted.
  const owner = owningMcpNamespace(name, allowed.mcpNamespaces ?? allowed.mcpServers.map((s) => s.namespace));
  if (owner !== null) {
    let policyDenied = false;
    for (const server of allowed.mcpServers) {
      if (server.namespace !== owner) continue;
      if (isMcpToolNameAllowed(name, server.policy)) return { allowed: true, category: 'mcp' };
      policyDenied = true;
    }
    if (policyDenied) return { allowed: false, reason: 'mcp_policy_denied' };
  }

  const staticId = name.endsWith('Tool') && allKnownStaticIds().has(name.slice(0, -4)) ? name.slice(0, -4) : name;
  const exclusion = allowed.excluded.get(staticId);
  if (exclusion) return { allowed: false, reason: exclusion };
  return { allowed: false, reason: 'not_allowed' };
}

/**
 * Decide one tool call. `names` holds the exposed key and, when known, the tool id;
 * the call is allowed when any name is allowed and none is a browser/computer tool.
 */
export function evaluateToolName(
  allowed: AllowedToolNames,
  names: string | readonly (string | undefined | null)[],
  surface: ToolSurface,
): ToolNameDecision {
  const list = (typeof names === 'string' ? [names] : names).filter(
    (n): n is string => typeof n === 'string' && n.length > 0,
  );
  if (list.length === 0) return { allowed: false, reason: 'not_allowed' };
  let firstDeny: ToolNameDecision | null = null;
  let allow: ToolNameDecision | null = null;
  for (const name of list) {
    const d = evaluateOneName(allowed, name, surface);
    if (!d.allowed && d.reason === 'browser_tools_disabled') return d;
    if (d.allowed) allow ??= d;
    else firstDeny ??= d;
  }
  return allow ?? firstDeny ?? { allowed: false, reason: 'not_allowed' };
}
