/**
 * #281 — Hermes → Tourbillon callback gate (web side).
 *
 * One API surface, principal = token: an external Hermes harness authenticates with the
 * run-scoped session token (pm_run_…, #110) minted into its heartbeat envelope. Every tool
 * call runs the SAME capability gate as in-system agents: the allowed set is
 * `assembleAgentTools(agentRecord, { allowedMcpServerIds, companySettings })` — the exact
 * assembly a durable/harness heartbeat uses. A tool outside that set (gated out by
 * assignedToolsets / assignedTools / mcpServerIds / company allow-list) is refused with 403
 * `tool_not_permitted` and NEVER executed.
 *
 * Route handlers under app/api/harness/callback/* are thin; all logic lives here and is
 * unit-tested with injected deps (no DB in tests).
 */
import { z } from 'zod';
import { HERMES_SKILL_INSTALL_MD } from '@tourbillon/shared/hermes-harness';

/** Minimal shape needed to dispatch; the real db Agent row satisfies it. */
export interface HarnessAgentRecordLike {
  id: string;
  companyId: string;
  [key: string]: unknown;
}

export interface HarnessCompanyLike {
  allowedMcpServerIds?: string[] | null;
  settings?: unknown;
}

export interface HarnessCaller {
  agentId: string;
  companyId: string;
  runId: string;
}

export interface HarnessCallbackDeps {
  /** authenticateAgentToken in production (signature + expiry + run-running DB check). */
  authenticate: (token: string | null) => Promise<HarnessCaller | null>;
  loadAgent: (agentId: string, companyId: string) => Promise<HarnessAgentRecordLike | null>;
  loadCompany: (companyId: string) => Promise<HarnessCompanyLike | null>;
  /** THE capability gate — same assembler the in-system wake path uses. */
  assembleTools: (
    agent: HarnessAgentRecordLike,
    options: { allowedMcpServerIds: string[]; companySettings: unknown },
  ) => Promise<Record<string, unknown>>;
  /** createHeartbeatRuntimeContext in production; anything `.get`-able works in tests. */
  buildRequestContext: (values: {
    apiKey: string;
    runId: string;
    agentId: string;
    companyId: string;
  }) => unknown;
  skillMarkdown?: () => string;
}

export interface HttpResult {
  status: number;
  body: unknown;
  contentType?: string;
}

/** Bearer token from an Authorization header value (same contract as agent-token-auth). */
export function harnessBearerToken(authorization: string | null | undefined): string | null {
  const t = authorization?.replace(/^Bearer\s+/i, '').trim();
  return t ? t : null;
}

const toolCallSchema = z.object({
  tool: z.string().min(1).max(200),
  args: z.record(z.string(), z.unknown()).optional(),
});

interface GateableTool {
  execute?: (input: unknown, context: { requestContext: unknown }) => Promise<unknown> | unknown;
  description?: string;
  inputSchema?: { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: unknown } };
}

function isZodLike(schema: GateableTool['inputSchema']): schema is NonNullable<GateableTool['inputSchema']> {
  return !!schema && typeof schema.safeParse === 'function';
}

async function authenticateAndLoad(
  authorization: string | null | undefined,
  deps: HarnessCallbackDeps,
): Promise<
  | { ok: false; result: HttpResult }
  | { ok: true; caller: HarnessCaller; agent: HarnessAgentRecordLike; token: string }
> {
  const token = harnessBearerToken(authorization);
  if (!token) {
    return { ok: false, result: { status: 401, body: { error: 'unauthorized', message: 'Missing session token' } } };
  }
  const caller = await deps.authenticate(token);
  if (!caller) {
    return { ok: false, result: { status: 401, body: { error: 'unauthorized', message: 'Invalid or expired session token' } } };
  }
  const agent = await deps.loadAgent(caller.agentId, caller.companyId);
  if (!agent) {
    return { ok: false, result: { status: 401, body: { error: 'unauthorized', message: 'Agent not found for session' } } };
  }
  return { ok: true, caller, agent, token };
}

async function assembleForCaller(
  agent: HarnessAgentRecordLike,
  companyId: string,
  deps: HarnessCallbackDeps,
): Promise<Record<string, unknown>> {
  const company = await deps.loadCompany(companyId);
  return deps.assembleTools(agent, {
    allowedMcpServerIds: company?.allowedMcpServerIds ?? [],
    companySettings: company?.settings ?? null,
  });
}

/**
 * POST /api/harness/callback/tools/call — { tool, args }.
 * Capability-denied tool calls return 403 WITHOUT executing (pinned behaviour test).
 */
export async function handleHarnessToolCall(params: {
  authorization: string | null | undefined;
  body: unknown;
  deps: HarnessCallbackDeps;
}): Promise<HttpResult> {
  const authed = await authenticateAndLoad(params.authorization, params.deps);
  if (!authed.ok) return authed.result;
  const { caller, agent, token } = authed;

  const parsed = toolCallSchema.safeParse(params.body);
  if (!parsed.success) {
    return { status: 400, body: { error: 'invalid_request', issues: parsed.error.issues.map((i) => i.message) } };
  }
  const { tool: toolName, args } = parsed.data;

  let tools: Record<string, unknown>;
  try {
    tools = await assembleForCaller(agent, caller.companyId, params.deps);
  } catch (err) {
    return {
      status: 500,
      body: { error: 'capability_gate_failed', message: err instanceof Error ? err.message : String(err) },
    };
  }

  // ── THE GATE: absent from the assembled set ⇒ refused, never executed. ──
  const tool = tools[toolName] as GateableTool | undefined;
  if (!tool || typeof tool.execute !== 'function') {
    return {
      status: 403,
      body: {
        error: 'tool_not_permitted',
        tool: toolName,
        message: `Tool '${toolName}' is not permitted for this agent (capability gate). Pick other work or report the block.`,
      },
    };
  }

  let validatedArgs: unknown = args ?? {};
  if (isZodLike(tool.inputSchema)) {
    const inputParse = tool.inputSchema.safeParse(validatedArgs);
    if (!inputParse.success) {
      return {
        status: 400,
        body: { error: 'invalid_args', tool: toolName, message: 'Arguments do not match the tool input schema' },
      };
    }
    validatedArgs = inputParse.data;
  }

  const requestContext = params.deps.buildRequestContext({
    apiKey: token,
    runId: caller.runId,
    agentId: caller.agentId,
    companyId: caller.companyId,
  });

  try {
    const result = await tool.execute(validatedArgs, { requestContext });
    return { status: 200, body: { tool: toolName, result } };
  } catch (err) {
    return {
      status: 500,
      body: { error: 'tool_execution_failed', tool: toolName, message: err instanceof Error ? err.message : String(err) },
    };
  }
}

/** GET /api/harness/callback/tools — the agent's allowed tool surface (same gate). */
export async function handleHarnessToolList(params: {
  authorization: string | null | undefined;
  deps: HarnessCallbackDeps;
}): Promise<HttpResult> {
  const authed = await authenticateAndLoad(params.authorization, params.deps);
  if (!authed.ok) return authed.result;

  let tools: Record<string, unknown>;
  try {
    tools = await assembleForCaller(authed.agent, authed.caller.companyId, params.deps);
  } catch (err) {
    return {
      status: 500,
      body: { error: 'capability_gate_failed', message: err instanceof Error ? err.message : String(err) },
    };
  }
  return {
    status: 200,
    body: {
      agentId: authed.caller.agentId,
      tools: Object.entries(tools).map(([name, value]) => ({
        name,
        description: (value as GateableTool)?.description ?? null,
      })),
    },
  };
}

/** GET /api/harness/callback/skill — the skill-install blob (auth-gated; no secrets inside). */
export async function handleHarnessSkill(params: {
  authorization: string | null | undefined;
  deps: HarnessCallbackDeps;
}): Promise<HttpResult> {
  const authed = await authenticateAndLoad(params.authorization, params.deps);
  if (!authed.ok) return authed.result;
  const md = params.deps.skillMarkdown?.() ?? HERMES_SKILL_INSTALL_MD;
  return { status: 200, body: md, contentType: 'text/markdown; charset=utf-8' };
}

/**
 * POST /api/harness/callback/chat — stub for this slice.
 * The measured Hermes gateway (agent card) advertises streaming, but wiring board chat to the
 * external harness is the follow-up pack (PR body carries the evidence). DMs already flow via
 * the capability-gated sendToAgent tool in the tools surface.
 */
export async function handleHarnessChat(params: {
  authorization: string | null | undefined;
  deps: HarnessCallbackDeps;
}): Promise<HttpResult> {
  const authed = await authenticateAndLoad(params.authorization, params.deps);
  if (!authed.ok) return authed.result;
  return {
    status: 501,
    body: {
      error: 'chat_not_implemented',
      message:
        'Board chat over the Hermes callback is not exposed in the first slice. Use the sendToAgent DM tool (when granted) for agent-to-agent messages.',
      followUp: '#281 next pack — see docs/backlog/harness-direct-connection.md',
    },
  };
}
