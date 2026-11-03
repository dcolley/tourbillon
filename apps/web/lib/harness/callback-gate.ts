/**
 * #281 — Hermes/OpenCode → Tourbillon callback gate (web side).
 *
 * One API surface, principal = token: an external harness (Hermes or OpenCode) authenticates
 * with the run-scoped session token (pm_run_…, #110) minted into its heartbeat envelope. Every
 * tool call runs the SAME capability gate as in-system agents: the allowed set is
 * `assembleAgentTools(agentRecord, { allowedMcpServerIds, companySettings })` — the exact
 * assembly a durable/harness heartbeat uses. A tool outside that set (gated out by
 * assignedToolsets / assignedTools / mcpServerIds / company allow-list) is refused with 403
 * `tool_not_permitted` and NEVER executed.
 *
 * Chat (AC5): `POST chat` is A2A JSONRPC (`message/send` sync / `message/stream` SSE), allowed
 * only for the legs the bind advertises (`adapterConfig.chat`), and delivered through the
 * agent's OWN gated DM tool (`sendToAgent` from the same assembly) — no second chat stack.
 *
 * The skill endpoint is harness-kind aware: an OpenCode-bound agent gets the OpenCode skill
 * blob, everyone else keeps the Hermes one (first-slice default).
 *
 * Route handlers under app/api/harness/callback/* are thin; all logic lives here and is
 * unit-tested with injected deps (no DB in tests).
 */
import { z } from 'zod';
import {
  HERMES_SKILL_INSTALL_MD,
  hermesHarnessBindSchema,
  isHermesHarnessBind,
} from '@tourbillon/shared/hermes-harness';
import {
  OPENCODE_SKILL_INSTALL_MD,
  isOpencodeHarnessBind,
  opencodeHarnessBindSchema,
} from '@tourbillon/shared/opencode-harness';
import {
  HARNESS_CHAT_MAX_TEXT,
  buildHarnessChatReply,
  encodeHarnessChatSse,
  harnessChatModeForMethod,
  harnessChatRequestSchema,
  harnessChatText,
  type A2aStatusUpdate,
  type HarnessChatMode,
} from '@tourbillon/shared/harness-chat';

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
  /** Id source for chat reply messageIds (crypto.randomUUID in production). */
  newId?: () => string;
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
 * Find an executable tool in the ASSEMBLED set by any of its name forms (S327-S1):
 *  1. exact assembled key (`getInboxTool`, or an MCP key as listed by GET tools);
 *  2. `${name}Tool` — the short id skills teach (`getInbox` → `getInboxTool`);
 *  3. `name` minus a trailing `Tool` (`getInboxTool` when assembled under `getInbox`);
 *  4. scan for a tool whose `id === name`, then (only if none) whose `id` is the `Tool`-stripped form.
 * Own keys only (no prototype lookups). Never consults anything outside `tools`, so a name
 * the gate did not assemble resolves to `none` ⇒ 403, never executed.
 *
 * S328-S1 precedence (pinned in callback-gate.test.ts): the tiers are strict — the first tier
 * that hits wins, so an assembled KEY always beats an id match (keys are unique by construction,
 * so tiers 1-3 can never be ambiguous). The id scans (tier 4) are the only place two different
 * tools can both claim a name (e.g. two MCP servers exposing the same tool id); that used to
 * resolve to whichever the assembler happened to insert first. It is now `ambiguous` and the
 * caller answers 409 without executing either.
 */
export type GatedToolLookup =
  | { kind: 'found'; tool: GateableTool; key: string }
  | { kind: 'ambiguous'; keys: string[] }
  | { kind: 'none' };

export function resolveGatedTool(tools: Record<string, unknown>, name: string): GatedToolLookup {
  const executable = (v: unknown): GateableTool | undefined => {
    const t = v as GateableTool | undefined;
    return t && typeof t === 'object' && typeof t.execute === 'function' ? t : undefined;
  };
  const stripped = name.endsWith('Tool') && name.length > 'Tool'.length ? name.slice(0, -'Tool'.length) : null;
  for (const key of [name, `${name}Tool`, ...(stripped ? [stripped] : [])]) {
    if (!Object.prototype.hasOwnProperty.call(tools, key)) continue;
    const t = executable(tools[key]);
    if (t) return { kind: 'found', tool: t, key };
  }
  for (const wanted of [name, ...(stripped ? [stripped] : [])]) {
    const hits: Array<[string, GateableTool]> = [];
    for (const [key, value] of Object.entries(tools)) {
      const t = executable(value);
      const id = (t as { id?: unknown } | undefined)?.id;
      if (t && typeof id === 'string' && id === wanted && !hits.some(([, h]) => h === t)) hits.push([key, t]);
    }
    if (hits.length === 1) return { kind: 'found', tool: hits[0][1], key: hits[0][0] };
    if (hits.length > 1) return { kind: 'ambiguous', keys: hits.map(([k]) => k).sort() };
  }
  return { kind: 'none' };
}

/** Executable tool for `name`, or `undefined` when absent OR ambiguous (fail closed). */
export function findGatedTool(tools: Record<string, unknown>, name: string): GateableTool | undefined {
  const hit = resolveGatedTool(tools, name);
  return hit.kind === 'found' ? hit.tool : undefined;
}

/**
 * POST /api/harness/callback/tools/call — { tool, args }.
 * `tool` may be the assembled key (`getInboxTool`) or the tool id skills teach (`getInbox`).
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
  // Resolve by assembled key OR tool id (S327-S1): skills teach `getInbox` / `sendToAgent`,
  // the assembler keys them `getInboxTool` / `sendToAgentTool`. Lookup is ONLY over the
  // assembled set, so name aliasing can never widen the gate.
  const lookup = resolveGatedTool(tools, toolName);
  if (lookup.kind === 'ambiguous') {
    // S328-S1: two assembled tools claim this id — refuse rather than run whichever came first.
    return {
      status: 409,
      body: {
        error: 'ambiguous_tool',
        tool: toolName,
        candidates: lookup.keys,
        message: `Tool '${toolName}' matches more than one assembled tool (${lookup.keys.join(', ')}). Call it by its assembled key.`,
      },
    };
  }
  const tool = lookup.kind === 'found' ? lookup.tool : undefined;
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

/**
 * Pick the skill-install blob for the authenticated agent's harness kind. An OpenCode-bound
 * agent gets the OpenCode SKILL.md shape (bind.skillInstall override wins when the bind
 * parses); everything else keeps the Hermes default. The skill never contains secrets, so the
 * selection is presentation-only — auth is still enforced by the caller.
 */
export function selectHarnessSkillMarkdown(agent: HarnessAgentRecordLike, deps: HarnessCallbackDeps): string {
  const adapterConfig = (agent as { adapterConfig?: unknown }).adapterConfig;
  if (isOpencodeHarnessBind(adapterConfig)) {
    const parsed = opencodeHarnessBindSchema.safeParse(adapterConfig);
    const override = parsed.success ? parsed.data.skillInstall?.trim() : undefined;
    return override || OPENCODE_SKILL_INSTALL_MD;
  }
  return deps.skillMarkdown?.() ?? HERMES_SKILL_INSTALL_MD;
}

/** GET /api/harness/callback/skill — the skill-install blob (auth-gated; no secrets inside). */
export async function handleHarnessSkill(params: {
  authorization: string | null | undefined;
  deps: HarnessCallbackDeps;
}): Promise<HttpResult> {
  const authed = await authenticateAndLoad(params.authorization, params.deps);
  if (!authed.ok) return authed.result;
  const md = selectHarnessSkillMarkdown(authed.agent, params.deps);
  return { status: 200, body: md, contentType: 'text/markdown; charset=utf-8' };
}

/**
 * Chat legs advertised by the authenticated agent's harness bind. Fails closed: no bind, a bind
 * that does not strictly parse, or no `chat` key ⇒ nothing advertised. Only Hermes / OpenCode
 * binds can chat; in-product agents (no bind) never use the harness callback chat.
 */
export function resolveHarnessChatCapability(
  agent: HarnessAgentRecordLike,
): { harness: 'hermes' | 'opencode'; sync: boolean; stream: boolean } | null {
  const adapterConfig = (agent as { adapterConfig?: unknown }).adapterConfig;
  let harness: 'hermes' | 'opencode';
  let chat: { sync?: boolean; stream?: boolean } | undefined;
  if (isHermesHarnessBind(adapterConfig)) {
    const parsed = hermesHarnessBindSchema.safeParse(adapterConfig);
    if (!parsed.success) return null;
    harness = 'hermes';
    chat = parsed.data.chat;
  } else if (isOpencodeHarnessBind(adapterConfig)) {
    const parsed = opencodeHarnessBindSchema.safeParse(adapterConfig);
    if (!parsed.success) return null;
    harness = 'opencode';
    chat = parsed.data.chat;
  } else {
    return null;
  }
  const sync = chat?.sync === true;
  const stream = chat?.stream === true;
  if (!sync && !stream) return null;
  return { harness, sync, stream };
}

/** The DM tool from the ASSEMBLED set only (keyed `sendToAgentTool` by the control plane). */
const DM_TOOL_ID = 'sendToAgent';
function findGatedDmTool(tools: Record<string, unknown>): GateableTool | undefined {
  return findGatedTool(tools, DM_TOOL_ID);
}

function deliveryFailed(result: unknown): string | null {
  if (result && typeof result === 'object' && 'error' in result) {
    const r = result as { error?: unknown; message?: unknown };
    if (r.error) return `${String(r.error)}${r.message ? `: ${String(r.message)}` : ''}`;
  }
  return null;
}

/**
 * POST /api/harness/callback/chat — AC5 harness chat (S316-S3 · S322-S5).
 *
 * Order (each step fails closed BEFORE anything executes):
 *  1. session token → 401;
 *  2. bind advertises chat → else 409 `chat_not_supported`;
 *  3. A2A JSONRPC body → 400; method must be `message/send` | `message/stream`;
 *  4. requested leg advertised → else 409 `chat_sync_not_supported` / `chat_stream_not_supported`
 *     (wins over any later 400 — a bad text/recipient on an unadvertised leg is still 409);
 *  5. message text (non-empty, ≤ HARNESS_CHAT_MAX_TEXT) → else 400 `invalid_request`;
 *  6. peer recipient (`metadata.tourbillon.toAgentId|toAgentUrlKey`) → else 400
 *     `chat_recipient_required`;
 *  7. capability gate: `sendToAgent` in `assembleAgentTools` → else 403 `chat_not_permitted`
 *     (never executed; only reached once every 400 has passed — assembly is not even run before);
 *  8. execute the gated DM tool with the session token as apiKey.
 * Sync ⇒ JSON-RPC result (A2A agent Message); delivery failure ⇒ 502 `chat_delivery_failed`.
 * Stream ⇒ SSE (status working → Message → final), BUFFERED: all frames are emitted together
 * after the DM completes (not incremental); delivery failure ⇒ HTTP 200 + final `failed`.
 */
export async function handleHarnessChat(params: {
  authorization: string | null | undefined;
  body?: unknown;
  deps: HarnessCallbackDeps;
}): Promise<HttpResult> {
  const authed = await authenticateAndLoad(params.authorization, params.deps);
  if (!authed.ok) return authed.result;
  const { caller, agent, token } = authed;

  const capability = resolveHarnessChatCapability(agent);
  if (!capability) {
    return {
      status: 409,
      body: {
        error: 'chat_not_supported',
        message:
          "This agent's harness bind does not advertise chat (adapterConfig.chat). Use the sendToAgent DM tool via tools/call (when granted) or issue comments.",
      },
    };
  }

  const parsed = harnessChatRequestSchema.safeParse(params.body);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: 'invalid_request', issues: parsed.error.issues.map((i) => i.message) },
    };
  }
  const request = parsed.data;
  const mode: HarnessChatMode | null = harnessChatModeForMethod(request.method);
  if (!mode) {
    return {
      status: 400,
      body: {
        error: 'unsupported_method',
        method: request.method,
        message: "Chat methods are 'message/send' (sync) and 'message/stream' (stream).",
      },
    };
  }
  if (!capability[mode]) {
    return {
      status: 409,
      body: {
        error: mode === 'stream' ? 'chat_stream_not_supported' : 'chat_sync_not_supported',
        method: request.method,
        message: `This harness bind does not advertise chat.${mode}; use the advertised leg (${
          capability.sync ? 'message/send' : 'message/stream'
        }).`,
      },
    };
  }

  const text = harnessChatText(request.params.message.parts);
  if (!text) {
    return { status: 400, body: { error: 'invalid_request', issues: ['message needs at least one non-empty text part'] } };
  }
  if (text.length > HARNESS_CHAT_MAX_TEXT) {
    return { status: 400, body: { error: 'invalid_request', issues: [`message text exceeds ${HARNESS_CHAT_MAX_TEXT} chars`] } };
  }
  const route = request.params.message.metadata?.tourbillon;
  if (!route?.toAgentId && !route?.toAgentUrlKey) {
    return {
      status: 400,
      body: {
        error: 'chat_recipient_required',
        message:
          'Set params.message.metadata.tourbillon.toAgentId or toAgentUrlKey. Board chat stays in the Tourbillon chat UI; reach the Board via issue comments.',
      },
    };
  }

  let tools: Record<string, unknown>;
  try {
    tools = await assembleForCaller(agent, caller.companyId, params.deps);
  } catch (err) {
    return {
      status: 500,
      body: { error: 'capability_gate_failed', message: err instanceof Error ? err.message : String(err) },
    };
  }

  // ── THE GATE: chat rides the agent's own DM tool; absent ⇒ refused, never executed. ──
  const dmTool = findGatedDmTool(tools);
  if (!dmTool || typeof dmTool.execute !== 'function') {
    return {
      status: 403,
      body: {
        error: 'chat_not_permitted',
        tool: DM_TOOL_ID,
        message: 'Chat is delivered via the sendToAgent DM tool, which is not permitted for this agent (capability gate).',
      },
    };
  }

  let args: unknown = {
    ...(route.toAgentId ? { toAgentId: route.toAgentId } : {}),
    ...(route.toAgentUrlKey ? { toAgentUrlKey: route.toAgentUrlKey } : {}),
    body: text,
    ...(route.inReplyTo ? { inReplyTo: route.inReplyTo } : {}),
  };
  if (isZodLike(dmTool.inputSchema)) {
    const inputParse = dmTool.inputSchema.safeParse(args);
    if (!inputParse.success) {
      return { status: 400, body: { error: 'invalid_args', tool: DM_TOOL_ID, message: 'Arguments do not match the DM tool input schema' } };
    }
    args = inputParse.data;
  }

  const requestContext = params.deps.buildRequestContext({
    apiKey: token,
    runId: caller.runId,
    agentId: caller.agentId,
    companyId: caller.companyId,
  });
  const newId = params.deps.newId ?? (() => globalThis.crypto.randomUUID());
  const recipient = route.toAgentUrlKey ?? route.toAgentId;

  let result: unknown;
  let failure: string | null;
  try {
    result = await dmTool.execute(args, { requestContext });
    failure = deliveryFailed(result);
  } catch (err) {
    result = undefined;
    failure = err instanceof Error ? err.message : String(err);
  }

  const reply = buildHarnessChatReply({
    messageId: newId(),
    contextId: caller.runId,
    text: failure ? `Delivery to ${recipient} failed: ${failure}` : `Delivered to ${recipient} via sendToAgent.`,
    data: { tool: DM_TOOL_ID, ...(failure ? { error: failure } : {}), result: result ?? null },
  });

  if (mode === 'sync') {
    if (failure) {
      return {
        status: 502,
        body: { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'chat_delivery_failed', data: reply } },
      };
    }
    return { status: 200, body: { jsonrpc: '2.0', id: request.id, result: reply } };
  }

  const taskId = `chat-${reply.messageId}`;
  const working: A2aStatusUpdate = {
    kind: 'status-update',
    taskId,
    contextId: caller.runId,
    status: { state: 'working' },
    final: false,
  };
  const done: A2aStatusUpdate = {
    kind: 'status-update',
    taskId,
    contextId: caller.runId,
    status: { state: failure ? 'failed' : 'completed', message: reply },
    final: true,
  };
  return {
    status: 200,
    body: encodeHarnessChatSse(request.id, [working, reply, done]),
    contentType: 'text/event-stream; charset=utf-8',
  };
}
