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
 * an `agent.tool_denied` activity row (tool name + reason only, never arguments). The gate
 * fails closed: an exception, a slow lookup or missing request context denies the call.
 */
import type { ToolHooks } from '@mastra/core/tools';
import { db, agents, companies, activityLog, eq, type Agent as AgentRecord, type Company } from '@tourbillon/db';
import {
  evaluateToolName,
  formatTrace,
  isBrowserOrComputerToolName,
  mcpServerToolNamespace,
  parseCompanySettings,
  resolveAllowedToolNames,
  type AllowedToolNames,
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
  | 'not_allowed';

export type ToolGateDecision = { allowed: true } | { allowed: false; reason: ToolGateReason };

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
  tool: string | null;
  reason: ToolGateReason | 'limit_reached';
  summary?: boolean;
}

export interface ToolGateDeps {
  loadAgent(agentId: string): Promise<ToolGateAgentRow | null | undefined>;
  loadCompany(companyId: string): Promise<ToolGateCompanyRow | null | undefined>;
  recordDenied(row: ToolDeniedActivity): Promise<void>;
  /** MCP server definition lookup (registry); injectable for tests. */
  getMcpServer(serverId: string): McpServerDefinition | undefined;
  listMcpServers(): McpServerDefinition[];
  now(): number;
}

export const TOOL_GATE_CACHE_TTL_MS = 5_000;
export const TOOL_GATE_TIMEOUT_MS = 2_000;
export const TOOL_DENIED_ROWS_PER_RUN = 20;
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
        surface: row.surface,
        ...(row.runId ? { runId: row.runId } : {}),
        ...(row.summary
          ? { summary: true, limit: TOOL_DENIED_ROWS_PER_RUN, message: 'Further tool denials in this run are not logged.' }
          : {}),
      },
    });
  },
  getMcpServer: getMcpServerDefinition,
  listMcpServers: listMcpServerDefinitions,
  now: () => Date.now(),
};

let deps: ToolGateDeps = defaultDeps;

interface GateState {
  agent: ToolGateAgentRow;
  company: ToolGateCompanyRow;
  allowed: AllowedToolNames;
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

function computeAllowed(agent: ToolGateAgentRow, company: ToolGateCompanyRow): AllowedToolNames {
  const serverIds = resolveAgentMcpServerIds(agent, {
    allowedMcpServerIds: company.allowedMcpServerIds ?? [],
    agentRuntime: agent.runtimeConfig,
  });
  const mcpServers = serverIds
    .map((id) => deps.getMcpServer(id))
    .filter((def): def is McpServerDefinition => Boolean(def));
  return resolveAllowedToolNames(agent, { settings: parseCompanySettings(company.settings) }, { mcpServers });
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
    // Allow-list is derived from the rows; reuse it while neither row's updatedAt moved.
    const sameRows =
      cached &&
      updatedAtMs(cached.agent.updatedAt) === updatedAtMs(agent.updatedAt) &&
      updatedAtMs(cached.company.updatedAt) === updatedAtMs(company.updatedAt);
    const state: GateState = {
      agent,
      company,
      allowed: sameRows ? cached.allowed : computeAllowed(agent, company),
      loadedAt: deps.now(),
    };
    if (stateCache.size >= MAX_CACHED_AGENTS) stateCache.delete(stateCache.keys().next().value as string);
    stateCache.set(key, state);
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
  const namespaces = deps.listMcpServers().map((def) => `${mcpServerToolNamespace(def.id)}_`);
  return names.some((name) => namespaces.some((ns) => name.startsWith(ns)));
}

/**
 * Tool-side network egress policy slot (web search, nitter, HTTP MCP). There is no tool-side
 * egress allow-list today (the sandbox egress allow-list governs code execution only), so this
 * allows; a tool egress policy plugs in here.
 */
function checkToolEgress(_state: GateState, _names: string[]): ToolGateDecision {
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

function recordDenial(input: CheckInput, reason: ToolGateReason, runId: string | undefined): void {
  const runKey = `${input.agentId}:${runId ?? input.surface}`;
  const count = (deniedCounts.get(runKey) ?? 0) + 1;
  if (!deniedCounts.has(runKey) && deniedCounts.size >= MAX_TRACKED_RUNS) {
    deniedCounts.delete(deniedCounts.keys().next().value as string);
  }
  deniedCounts.set(runKey, count);

  const tool = input.toolName || input.toolId || null;
  console.warn(
    formatTrace('tool-gate', { agentId: input.agentId, companyId: input.companyId, runId }, 'tool call denied', {
      tool,
      reason,
      surface: input.surface,
    }),
  );

  if (count > TOOL_DENIED_ROWS_PER_RUN + 1) return;
  const summary = count === TOOL_DENIED_ROWS_PER_RUN + 1;
  const agentName = stateCache.get(cacheKey(input))?.agent.name ?? null;
  const row: ToolDeniedActivity = summary
    ? { companyId: input.companyId, agentId: input.agentId, agentName, surface: input.surface, runId, tool: null, reason: 'limit_reached', summary: true }
    : { companyId: input.companyId, agentId: input.agentId, agentName, surface: input.surface, runId, tool, reason };
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
  if (!decision.allowed) {
    let runId: string | undefined;
    try {
      runId = extractToolRuntimeContext(input.requestContext).runId;
    } catch {
      runId = undefined;
    }
    recordDenial(input, decision.reason, runId);
  }
  return decision;
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
): { tools: () => T; hooks: ToolHooks } {
  return {
    tools: () => tools,
    hooks: createToolGateHooks(ctx),
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
