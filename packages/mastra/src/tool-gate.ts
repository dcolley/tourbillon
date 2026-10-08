/**
 * Live tool permission gate.
 *
 * Every tool call is checked at call time against the agent's current allow-list, read fresh
 * from the database (cached for at most TOOL_GATE_CACHE_TTL_MS). Wired in two places:
 *   1. Agent-level `hooks.beforeToolCall` on every Mastra Agent Tourbillon builds
 *      (heartbeat, harness controller, dashboard chat) via {@link gatedAgentOptions}.
 *   2. Inside each assembled tool's `execute` (tools/redact-tool-output.ts), so a tool instance
 *      only ever runs for the agent it was built for.
 *
 * A denied call returns a structured tool result to the model (the run continues) and writes
 * an `agent.tool_denied` activity row (tool name + reason only, never arguments; outbound-host
 * denials add the host). The gate fails closed: an exception, a slow lookup or missing request
 * context denies the call.
 *
 * A name the agent does not hold at all never reaches the hook: Mastra answers it with a
 * `ToolNotFoundError` tool result first. An agent-level output processor
 * ({@link createUnknownToolAuditProcessor}) catches that result and logs it as `unknown_tool`
 * under the same per-run cap, so every refused tool call leaves a row.
 *
 * Denial rows are capped per run ({@link TOOL_DENIED_ROWS_PER_RUN} + one summary row). The cap
 * key is the run id plus, when present, the memory thread id, so each dashboard chat thread
 * (which shares one run id per agent) has its own cap.
 */
import type { ToolHooks } from '@mastra/core/tools';
import type { OutputProcessor } from '@mastra/core/processors';
import { db, agents, companies, activityLog, eq, type Agent as AgentRecord, type Company } from '@tourbillon/db';
import {
  evaluateToolName,
  formatTrace,
  isBrowserOrComputerToolName,
  mcpServerToolNamespace,
  owningMcpNamespace,
  parseCompanySettings,
  resolveAllowedToolNames,
  resolveToolEgressPolicy,
  resolveToolEgressTargets,
  checkToolEgressTarget,
  isToolEgressRestricted,
  malformedToolEgressAllowListWarning,
  type AgentRuntimeConfig,
  type AllowedToolNames,
  type CompanySettings,
  type ToolEgressPolicy,
  type ToolEgressTargetContext,
  type ToolSurface,
} from '@tourbillon/shared';
import {
  getMcpServerDefinition,
  listMcpServerDefinitions,
  resolveAgentMcpServerIds,
  type McpServerDefinition,
} from '@tourbillon/shared/mcp-registry';
import { extractToolRuntimeContext } from './tools/api-client';

export type ToolGateSurface = ToolSurface;

export interface ToolGateContext {
  /** Agent the tools were built for. */
  agentId: string;
  companyId: string;
  surface: ToolGateSurface;
}

export type ToolGateReason =
  | 'gate_error'
  | 'context_mismatch'
  | 'agent_not_found'
  | 'agent_archived'
  | 'agent_pending_approval'
  | 'agent_paused'
  | 'company_inactive'
  | 'browser_tools_disabled'
  | 'mail_disabled'
  | 'web_search_not_configured'
  | 'not_in_toolset'
  | 'mcp_policy_denied'
  | 'mcp_server_not_allowed'
  | 'egress_not_allowed'
  | 'not_allowed'
  /** The model called a name the agent does not hold (Mastra answered `ToolNotFoundError`). */
  | 'unknown_tool';

export type ToolGateDecision =
  | { allowed: true }
  | { allowed: false; reason: ToolGateReason; /** Outbound host (egress denials only). */ host?: string };

export interface ToolNotAllowedResult {
  error: 'tool_not_allowed';
  tool: string;
  reason: ToolGateReason;
  message: string;
}

export type ToolGateAgentRow = Pick<
  AgentRecord,
  'id' | 'companyId' | 'name' | 'role' | 'status' | 'assignedToolsets' | 'mcpServerIds' | 'runtimeConfig' | 'updatedAt'
>;
export type ToolGateCompanyRow = Pick<Company, 'id' | 'status' | 'settings' | 'allowedMcpServerIds' | 'updatedAt'>;

export interface ToolDeniedActivity {
  companyId: string;
  agentId: string;
  agentName?: string | null;
  surface: ToolGateSurface;
  runId?: string;
  /** Memory thread the call ran in (dashboard chat threads), when known. */
  threadId?: string;
  tool: string | null;
  reason: ToolGateReason | 'limit_reached';
  /** Outbound host for egress denials (host only, never a URL). */
  host?: string;
  summary?: boolean;
}

export interface ToolGateDeps {
  loadAgent(agentId: string): Promise<ToolGateAgentRow | null | undefined>;
  loadCompany(companyId: string): Promise<ToolGateCompanyRow | null | undefined>;
  recordDenied(row: ToolDeniedActivity): Promise<void>;
  /** MCP server definition lookup (registry); injectable for tests. */
  getMcpServer(serverId: string): McpServerDefinition | undefined;
  listMcpServers(): McpServerDefinition[];
  /** Outbound URLs a tool call will contact (from configuration); injectable for tests. */
  resolveEgressTargets(names: string[], ctx: ToolEgressTargetContext): string[];
  /** Server warning line (malformed stored allow-list); injectable for tests. */
  warn(line: string): void;
  now(): number;
}

export const TOOL_GATE_CACHE_TTL_MS = 5_000;
export const TOOL_GATE_TIMEOUT_MS = 2_000;
export const TOOL_DENIED_ROWS_PER_RUN = 20;
/** Longest tool name stored on a denial row (model-chosen names are untrusted text). */
export const TOOL_DENIED_NAME_MAX = 128;
const MAX_TRACKED_RUNS = 1_000;
const MAX_CACHED_AGENTS = 2_000;

const defaultDeps: ToolGateDeps = {
  loadAgent: async (agentId) =>
    db.query.agents.findFirst({
      where: eq(agents.id, agentId),
      columns: {
        id: true,
        companyId: true,
        name: true,
        role: true,
        status: true,
        assignedToolsets: true,
        mcpServerIds: true,
        runtimeConfig: true,
        updatedAt: true,
      },
    }),
  loadCompany: async (companyId) =>
    db.query.companies.findFirst({
      where: eq(companies.id, companyId),
      columns: { id: true, status: true, settings: true, allowedMcpServerIds: true, updatedAt: true },
    }),
  recordDenied: async (row) => {
    await db.insert(activityLog).values({
      companyId: row.companyId,
      actorType: 'agent',
      actorId: row.agentId,
      actorName: row.agentName ?? null,
      action: 'agent.tool_denied',
      entityType: 'agent',
      entityId: row.agentId,
      details: {
        tool: row.tool,
        reason: row.reason,
        ...(row.host ? { host: row.host } : {}),
        surface: row.surface,
        ...(row.runId ? { runId: row.runId } : {}),
        ...(row.threadId ? { threadId: row.threadId } : {}),
        ...(row.summary
          ? {
              summary: true,
              limit: TOOL_DENIED_ROWS_PER_RUN,
              message: row.threadId
                ? 'Further tool denials in this chat thread are not logged.'
                : 'Further tool denials in this run are not logged.',
            }
          : {}),
      },
    });
  },
  getMcpServer: getMcpServerDefinition,
  listMcpServers: listMcpServerDefinitions,
  resolveEgressTargets: resolveToolEgressTargets,
  warn: (line) => console.warn(line),
  now: () => Date.now(),
};

let deps: ToolGateDeps = defaultDeps;

interface GateEgress {
  policy: ToolEgressPolicy;
  companySettings: CompanySettings;
  agentRuntime: AgentRuntimeConfig;
  mcpServers: McpServerDefinition[];
  /** Diagnostic line (ids only) when a stored list is malformed; logged once per cache refresh. */
  malformedWarning: string | null;
}

interface GateState {
  agent: ToolGateAgentRow;
  company: ToolGateCompanyRow;
  /**
   * Derived from the agent and company rows plus the MCP registry. Reused across cache
   * refreshes while both rows' `updatedAt` are unchanged (see loadState).
   */
  allowed: AllowedToolNames;
  egress: GateEgress;
  loadedAt: number;
}

const stateCache = new Map<string, GateState>();
const inflight = new Map<string, Promise<GateState | ToolGateReason>>();
const deniedCounts = new Map<string, number>();

/** Test hook: swap data sources (DB, activity writer, clock). Clears gate caches. */
export function setToolGateDepsForTests(overrides: Partial<ToolGateDeps> = {}): void {
  deps = { ...defaultDeps, ...overrides };
  resetToolGateCaches();
}

export function resetToolGateCaches(): void {
  stateCache.clear();
  inflight.clear();
  deniedCounts.clear();
}

const MESSAGES: Partial<Record<ToolGateReason, string>> = {
  gate_error: 'Tool permission check failed; the tool was not run. Try again later.',
  context_mismatch: 'This tool belongs to a different agent session and was not run.',
  agent_not_found: 'Agent not found; tools are disabled.',
  agent_archived: 'This agent is archived; tools are disabled.',
  agent_pending_approval: 'This agent is pending board approval; tools are disabled.',
  agent_paused: 'This agent is paused; tools are disabled.',
  company_inactive: 'This company is not active; tools are disabled.',
  egress_not_allowed: "This tool's outbound host is not on the allow-list for agent tools; the tool was not run.",
};

export function toolNotAllowedResult(tool: string, reason: ToolGateReason): ToolNotAllowedResult {
  return {
    error: 'tool_not_allowed',
    tool,
    reason,
    message: MESSAGES[reason] ?? 'Tool not available to you. Call listTools to see the tools you have.',
  };
}

function cacheKey(ctx: ToolGateContext): string {
  return `${ctx.companyId}:${ctx.agentId}`;
}

function updatedAtMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') return new Date(value).getTime();
  return NaN;
}

function computeAllowed(
  agent: ToolGateAgentRow,
  company: ToolGateCompanyRow,
): { allowed: AllowedToolNames; egress: GateEgress } {
  const serverIds = resolveAgentMcpServerIds(agent, {
    allowedMcpServerIds: company.allowedMcpServerIds ?? [],
    agentRuntime: agent.runtimeConfig,
  });
  const mcpServers = serverIds
    .map((id) => deps.getMcpServer(id))
    .filter((def): def is McpServerDefinition => Boolean(def));
  const companySettings = parseCompanySettings(company.settings);
  const agentRuntime = (agent.runtimeConfig ?? {}) as AgentRuntimeConfig;
  const egress: GateEgress = {
    policy: resolveToolEgressPolicy(companySettings, agentRuntime),
    companySettings,
    agentRuntime,
    mcpServers,
    malformedWarning: malformedToolEgressAllowListWarning({
      companyId: company.id,
      companyList: (company.settings as Record<string, unknown> | null | undefined)?.toolEgressAllowList,
      agentId: agent.id,
      agentList: agentRuntime.toolEgressAllowList,
    }),
  };
  return {
    allowed: resolveAllowedToolNames(
      agent,
      { settings: companySettings },
      { mcpServers, knownMcpServerIds: deps.listMcpServers().map((def) => def.id) },
    ),
    egress,
  };
}

async function loadState(ctx: ToolGateContext): Promise<GateState | ToolGateReason> {
  const key = cacheKey(ctx);
  const now = deps.now();
  const cached = stateCache.get(key);
  if (cached && now - cached.loadedAt < TOOL_GATE_CACHE_TTL_MS) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  const load = (async (): Promise<GateState | ToolGateReason> => {
    const [agent, company] = await Promise.all([deps.loadAgent(ctx.agentId), deps.loadCompany(ctx.companyId)]);
    if (!agent || agent.companyId !== ctx.companyId) return 'agent_not_found';
    if (!company) return 'company_inactive';
    // The allow-list is derived from the rows; reuse it while neither row's updatedAt moved.
    // This relies on every writer of an allow-list input (agent toolsets, assigned tools,
    // mcpServerIds, runtimeConfig, status, role; company settings and allowedMcpServerIds)
    // bumping `updated_at` on the row it changes. A writer that skips the bump is only seen
    // once the other row changes. Agent status / company status are read from the fresh rows
    // on every refresh regardless. Pinned by the tool-gate tests ("updated_at dependency").
    const sameRows =
      cached &&
      updatedAtMs(cached.agent.updatedAt) === updatedAtMs(agent.updatedAt) &&
      updatedAtMs(cached.company.updatedAt) === updatedAtMs(company.updatedAt);
    const derived = sameRows ? { allowed: cached.allowed, egress: cached.egress } : computeAllowed(agent, company);
    const state: GateState = {
      agent,
      company,
      allowed: derived.allowed,
      egress: derived.egress,
      loadedAt: deps.now(),
    };
    if (stateCache.size >= MAX_CACHED_AGENTS) stateCache.delete(stateCache.keys().next().value as string);
    stateCache.set(key, state);
    if (state.egress.malformedWarning) deps.warn(state.egress.malformedWarning);
    return state;
  })();
  inflight.set(key, load);
  try {
    return await load;
  } finally {
    inflight.delete(key);
  }
}

function matchesAnyRegisteredMcpServer(names: string[]): boolean {
  const namespaces = deps.listMcpServers().map((def) => mcpServerToolNamespace(def.id));
  return names.some((name) => owningMcpNamespace(name, namespaces) !== null);
}

/**
 * Outbound host allow-list for tools (company and agent `toolEgressAllowList`). No list set →
 * allowed. Otherwise every host the tool will contact (SearXNG, Tavily, Nitter, HTTP MCP server;
 * taken from configuration, never from arguments) must be on the list(s). Redirects are checked
 * where the request is made (fetchWithToolEgress). The sandbox allow-list governs code execution.
 */
function checkToolEgress(state: GateState, names: string[]): ToolGateDecision {
  const { policy, companySettings, agentRuntime, mcpServers } = state.egress;
  if (!isToolEgressRestricted(policy)) return { allowed: true };
  const servers = mcpServers.map((def) => ({
    namespace: mcpServerToolNamespace(def.id),
    transport: def.transport,
    url: def.url,
    urlEnvVar: def.urlEnvVar,
  }));
  const targets = deps.resolveEgressTargets(names, { companySettings, agentRuntime, mcpServers: servers });
  for (const url of targets) {
    const decision = checkToolEgressTarget(policy, url);
    if (!decision.allowed) {
      return decision.host
        ? { allowed: false, reason: 'egress_not_allowed', host: decision.host }
        : { allowed: false, reason: 'egress_not_allowed' };
    }
  }
  return { allowed: true };
}

interface CheckInput extends ToolGateContext {
  /** Exposed tool key (what the model called). */
  toolName: string;
  /** Tool id, when known (tool instances carry it). */
  toolId?: string;
  requestContext: unknown;
}

async function evaluate(input: CheckInput): Promise<ToolGateDecision> {
  if (!input.agentId || !input.companyId) return { allowed: false, reason: 'gate_error' };
  const rc = extractToolRuntimeContext(input.requestContext);
  if (!rc.agentId || !rc.companyId) return { allowed: false, reason: 'gate_error' };
  if (rc.agentId !== input.agentId || rc.companyId !== input.companyId) {
    return { allowed: false, reason: 'context_mismatch' };
  }

  const names = [input.toolName, input.toolId].filter((n): n is string => typeof n === 'string' && n.length > 0);
  if (names.length === 0) return { allowed: false, reason: 'gate_error' };
  if (names.some(isBrowserOrComputerToolName)) return { allowed: false, reason: 'browser_tools_disabled' };

  const state = await loadState(input);
  if (typeof state === 'string') return { allowed: false, reason: state };

  const { agent, company } = state;
  if (agent.status === 'archived') return { allowed: false, reason: 'agent_archived' };
  if (agent.status === 'pending_approval') return { allowed: false, reason: 'agent_pending_approval' };
  if (agent.status === 'paused' && input.surface !== 'chat') return { allowed: false, reason: 'agent_paused' };
  if (company.status !== 'active') return { allowed: false, reason: 'company_inactive' };

  const decision = evaluateToolName(state.allowed, names, input.surface);
  if (!decision.allowed) {
    if (decision.reason === 'not_allowed' && matchesAnyRegisteredMcpServer(names)) {
      return { allowed: false, reason: 'mcp_server_not_allowed' };
    }
    return { allowed: false, reason: decision.reason };
  }
  return checkToolEgress(state, names);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tool gate timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

interface DenialScope {
  runId?: string;
  threadId?: string;
}

/** Run id (Tourbillon request context) and memory thread id (Mastra) for the denial cap. */
function denialScope(requestContext: unknown): DenialScope {
  let runId: string | undefined;
  let threadId: string | undefined;
  try {
    runId = extractToolRuntimeContext(requestContext).runId;
  } catch {
    runId = undefined;
  }
  try {
    const rc = requestContext as { get?: (key: string) => unknown } | undefined;
    if (rc && typeof rc.get === 'function') {
      const memory = rc.get('MastraMemory') as { thread?: { id?: unknown } } | undefined;
      const candidate = memory?.thread?.id ?? rc.get('mastra__threadId');
      if (typeof candidate === 'string' && candidate.length > 0) threadId = candidate;
    }
  } catch {
    threadId = undefined;
  }
  return { runId, threadId };
}

/** Cap key: per run, and per memory thread when there is one (chat threads share a run id). */
export function denialCapKey(agentId: string, surface: ToolGateSurface, scope: DenialScope): string {
  return `${agentId}:${scope.runId ?? surface}:${scope.threadId ?? ''}`;
}

function recordDenial(input: CheckInput, reason: ToolGateReason, scope: DenialScope, host?: string): void {
  const { runId, threadId } = scope;
  const runKey = denialCapKey(input.agentId, input.surface, scope);
  const count = (deniedCounts.get(runKey) ?? 0) + 1;
  if (!deniedCounts.has(runKey) && deniedCounts.size >= MAX_TRACKED_RUNS) {
    deniedCounts.delete(deniedCounts.keys().next().value as string);
  }
  deniedCounts.set(runKey, count);

  const rawTool = input.toolName || input.toolId || null;
  const tool = rawTool && rawTool.length > TOOL_DENIED_NAME_MAX ? `${rawTool.slice(0, TOOL_DENIED_NAME_MAX)}…` : rawTool;
  console.warn(
    formatTrace('tool-gate', { agentId: input.agentId, companyId: input.companyId, runId }, 'tool call denied', {
      tool,
      reason,
      ...(host ? { host } : {}),
      surface: input.surface,
    }),
  );

  if (count > TOOL_DENIED_ROWS_PER_RUN + 1) return;
  const summary = count === TOOL_DENIED_ROWS_PER_RUN + 1;
  const agentName = stateCache.get(cacheKey(input))?.agent.name ?? null;
  const base = { companyId: input.companyId, agentId: input.agentId, agentName, surface: input.surface, runId, ...(threadId ? { threadId } : {}) };
  const row: ToolDeniedActivity = summary
    ? { ...base, tool: null, reason: 'limit_reached', summary: true }
    : { ...base, tool, reason, ...(host ? { host } : {}) };
  void Promise.resolve()
    .then(() => deps.recordDenied(row))
    .catch((err) => {
      console.warn(
        formatTrace('tool-gate', { agentId: input.agentId, runId }, 'failed to record tool denial', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    });
}

/**
 * Decide whether `toolName` may run now for the agent in `input`. Never throws.
 * Deny (with an activity row) on any failure, timeout or missing/mismatched context.
 */
export async function checkToolPermission(input: CheckInput): Promise<ToolGateDecision> {
  let decision: ToolGateDecision;
  try {
    decision = await withTimeout(evaluate(input), TOOL_GATE_TIMEOUT_MS);
  } catch (err) {
    console.warn(
      formatTrace('tool-gate', { agentId: input.agentId }, 'tool permission check failed', {
        tool: input.toolName,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    decision = { allowed: false, reason: 'gate_error' };
  }
  if (!decision.allowed) recordDenial(input, decision.reason, denialScope(input.requestContext), decision.host);
  return decision;
}

/**
 * Log a tool call Mastra refused with `ToolNotFoundError` (a name the agent does not hold) as an
 * `agent.tool_denied` row with reason `unknown_tool`, under the same per-run cap. Never throws.
 */
export function recordUnknownToolCall(ctx: ToolGateContext, toolName: string, requestContext: unknown): void {
  try {
    const name = typeof toolName === 'string' && toolName.length > 0 ? toolName : '(unnamed)';
    recordDenial({ ...ctx, toolName: name, requestContext }, 'unknown_tool', denialScope(requestContext));
  } catch (err) {
    console.warn(
      formatTrace('tool-gate', { agentId: ctx.agentId }, 'failed to record unknown tool call', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

function isToolNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as { name?: unknown }).name === 'ToolNotFoundError';
}

/**
 * Agent-level output processor: watches the run's stream for `tool-error` results carrying
 * `ToolNotFoundError` (Mastra answers those before any tool hook runs, on the durable and the
 * plain agent paths) and records them via {@link recordUnknownToolCall}. Passes every chunk
 * through unchanged.
 */
export function createUnknownToolAuditProcessor(ctx: ToolGateContext): OutputProcessor {
  return {
    id: 'tourbillon-unknown-tool-audit',
    name: 'Unknown tool audit',
    processOutputStream: async ({ part, requestContext }) => {
      try {
        const chunk = part as { type?: string; payload?: { toolName?: unknown; error?: unknown } };
        if (chunk?.type === 'tool-error' && isToolNotFoundError(chunk.payload?.error)) {
          recordUnknownToolCall(ctx, String(chunk.payload?.toolName ?? ''), requestContext);
        }
      } catch {
        // Auditing must never break the run.
      }
      return part;
    },
  };
}

/** Agent-level hooks: deny returns a structured tool result instead of running the tool. */
export function createToolGateHooks(ctx: ToolGateContext): ToolHooks {
  return {
    beforeToolCall: async ({ toolName, context }) => {
      const requestContext = (context as { requestContext?: unknown } | undefined)?.requestContext;
      const decision = await checkToolPermission({ ...ctx, toolName, requestContext });
      if (decision.allowed) return;
      return { proceed: false as const, output: toolNotAllowedResult(toolName, decision.reason) };
    },
  };
}

/**
 * Tool + hook options for `new Agent(...)`. Tools are passed as a function so they are resolved
 * per call for this agent only and are never copied into a shared Mastra tool registry.
 */
export function gatedAgentOptions<T extends Record<string, unknown>>(
  ctx: ToolGateContext,
  tools: T,
): { tools: () => T; hooks: ToolHooks; outputProcessors: OutputProcessor[] } {
  return {
    tools: () => tools,
    hooks: createToolGateHooks(ctx),
    // Builders must not pass their own `outputProcessors` after this spread (it would drop the audit).
    outputProcessors: [createUnknownToolAuditProcessor(ctx)],
  };
}

/** True when the Mastra instance holds no tools in its global tool registry. */
export function isMastraToolRegistryEmpty(mastra: { listTools?: () => unknown }): boolean {
  const tools = mastra.listTools?.();
  return !tools || Object.keys(tools as Record<string, unknown>).length === 0;
}

/** Throw when any tool has been registered on the Mastra instance (agent tools must stay per agent). */
export function assertMastraToolRegistryEmpty(mastra: { listTools?: () => unknown }): void {
  if (isMastraToolRegistryEmpty(mastra)) return;
  const names = Object.keys((mastra.listTools?.() ?? {}) as Record<string, unknown>);
  throw new Error(
    `Mastra tool registry must stay empty; agent tools are per agent (found ${names.length} registered tool(s)).`,
  );
}
