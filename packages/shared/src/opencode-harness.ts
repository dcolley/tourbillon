/**
 * #281 — OpenCode direct harness connection (second pack).
 *
 * Binds a Tourbillon agent to an EXTERNAL OpenCode harness. The bind lives entirely in
 * `agents.adapterConfig` (jsonb) — no migration, no new adapterType enum. An OpenCode-bound
 * agent keeps `adapterType = 'harness_local'` (UI/runtime class "Harness"); the discriminator
 * is `adapterConfig.harness === 'opencode'` (parallel to `'hermes'`). Agents without that key
 * are the in-product Mastra AgentController harness, untouched by this module.
 *
 * Product lock (docs/backlog/harness-direct-connection.md, acceptance item 6):
 *  - One MCP/API surface. Principal = token. External tool calls run the SAME capability gate
 *    as in-system agents (apps/web/lib/harness/callback-gate.ts).
 *  - Local bind is the default (command and/or loopback baseUrl). Remote is opt-in and demands
 *    `harnessBaseUrl` + `apiToken`.
 *  - EVERY heartbeat (local and remote) stamps `callback.baseUrl` + `callback.sessionToken` so
 *    OpenCode phones home. Privacy default: loopback callback (http://127.0.0.1:<port>/…).
 *
 * MEASURED OpenCode surface (opencode 1.18.35, `opencode serve --hostname 127.0.0.1`,
 * 2026-11-03) — this module speaks THAT, not the Hermes A2A surface:
 *  - `POST /session` {title?, metadata?} → session row `{ id: "ses_…", … }` (additionalProperties
 *    false; `metadata` is a free-form object — the machine-readable envelope rides here).
 *  - `POST /session/{id}/message` {model?: {providerID, modelID}, parts:[{type:"text",text}], …}
 *    → SYNCHRONOUS `{ info: AssistantMessage, parts: Part[] }`; `info.finish === "stop"` on
 *    success; `info.tokens = {input, output, reasoning, cache, total}`; `info.cost` reported.
 *  - `GET /event` → SSE stream (`server.connected`, session/message events) — the streaming
 *    leg is a documented follow-up; this slice uses the sync prompt.
 *  - `GET /skill` → installed skills as `{name, description, location, content}` — OpenCode
 *    skills are SKILL.md files with frontmatter (measured discovery path
 *    `~/.agents/skills/<name>/SKILL.md`; project skills live under `.opencode/skill/`).
 *  - `opencode serve` is UNSECURED unless `OPENCODE_SERVER_PASSWORD` is set; with it, every
 *    request without credentials gets 401 + `www-authenticate: Basic realm="Secure Area"`.
 *    (Basic credential acceptance itself could not be reproduced via curl on 1.18.35 — remote
 *    binds must therefore sit behind an operator-managed authenticating TLS proxy; the
 *    `apiToken` rides as `Authorization: Bearer` for that proxy to validate.)
 *  - OpenCode messages carry no per-message metadata field, so the heartbeat envelope rides
 *    BOTH in the prompt text (fenced ```json block, parsed by the skill) AND in session
 *    `metadata.tourbillon` (machine-readable). Envelope kind/version stay identical to Hermes
 *    (`tourbillon.heartbeat` v1) — OpenCode consumes JSON metadata fine.
 *
 * Never log `apiToken` or `sessionToken`.
 */
import { z } from 'zod';

/** adapterConfig discriminator for the external OpenCode bind. */
export const OPENCODE_HARNESS_KIND = 'opencode' as const;

/** Envelope discriminator carried to the harness on every heartbeat (same contract as Hermes). */
export const OPENCODE_HEARTBEAT_KIND = 'tourbillon.heartbeat' as const;
export const OPENCODE_HEARTBEAT_VERSION = 1 as const;

/** Env vars set on a local `command` spawn so a CLI harness can read the wake.
 *  Same names as the Hermes bind — a harness-agnostic wrapper script reads either. */
export const OPENCODE_WAKE_ENV = {
  wakeJson: 'TOURBILLON_WAKE_JSON',
  callbackUrl: 'TOURBILLON_CALLBACK_URL',
  sessionToken: 'TOURBILLON_SESSION_TOKEN',
} as const;

/** Tourbillon callback endpoints the skill teaches the harness to call (shared route stack). */
export const OPENCODE_CALLBACK_PATHS = {
  toolsList: '/api/harness/callback/tools',
  toolsCall: '/api/harness/callback/tools/call',
  skill: '/api/harness/callback/skill',
  chat: '/api/harness/callback/chat',
} as const;

/** Fallback callback origin when INTERNAL_API_URL is unset/unparseable (port 3002 = web app). */
export const OPENCODE_DEFAULT_CALLBACK_ORIGIN = 'http://127.0.0.1:3002';

/** Remote api tokens below this length are almost certainly typos; reject at save time. */
export const OPENCODE_REMOTE_API_TOKEN_MIN_LENGTH = 16;

export class OpencodeHarnessConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpencodeHarnessConfigError';
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('127.');
}

/** Absolute http(s) origin URL with no embedded credentials / query / hash. */
const httpOriginUrl = z
  .string()
  .refine(
    (v) => {
      try {
        const u = new URL(v);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        if (u.username || u.password) return false;
        if (u.search) return false;
        if (u.hash) return false;
        return true;
      } catch {
        return false;
      }
    },
    { message: 'must be an absolute http(s) URL without credentials, query or hash' },
  )
  .transform((v) => v.replace(/\/+$/, ''));

const localLoopbackUrl = httpOriginUrl.refine(
  (v) => isLoopbackHostname(new URL(v).hostname),
  { message: 'local harness baseUrl must point at a loopback host (127.0.0.1 / localhost / ::1)' },
);

export const opencodeHarnessBindSchema = z
  .object({
    harness: z.literal(OPENCODE_HARNESS_KIND),
    mode: z.enum(['local', 'remote']),
    /** Local CLI: shell command that starts OpenCode and reads the wake from stdin/env. */
    command: z.string().min(1).optional(),
    /** Local API: loopback `opencode serve` origin. */
    localBaseUrl: localLoopbackUrl.optional(),
    /** Remote OpenCode origin (behind an operator-managed authenticating TLS proxy). */
    harnessBaseUrl: httpOriginUrl.optional(),
    /** Bearer token presented to the remote proxy/gateway for the OpenCode API. */
    apiToken: z.string().min(1).optional(),
    /** Override the phone-home origin; default is loopback derived from INTERNAL_API_URL. */
    callbackBaseUrl: httpOriginUrl.optional(),
    /** Replace the bundled skill-install blob served at the callback `skill` endpoint. */
    skillInstall: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((bind, ctx) => {
    if (bind.mode === 'local') {
      if (!bind.command && !bind.localBaseUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['command'],
          message: "local OpenCode bind needs 'command' and/or loopback 'localBaseUrl'",
        });
      }
    } else {
      if (!bind.harnessBaseUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['harnessBaseUrl'],
          message: "remote OpenCode bind requires 'harnessBaseUrl'",
        });
      }
      if (!bind.apiToken || bind.apiToken.trim().length < OPENCODE_REMOTE_API_TOKEN_MIN_LENGTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['apiToken'],
          message: `remote OpenCode bind requires 'apiToken' of at least ${OPENCODE_REMOTE_API_TOKEN_MIN_LENGTH} chars`,
        });
      }
    }
  });

export type OpencodeHarnessBind = z.infer<typeof opencodeHarnessBindSchema>;

/** Cheap discriminator: does this adapterConfig declare an external OpenCode bind? */
export function isOpencodeHarnessBind(adapterConfig: unknown): boolean {
  return (
    !!adapterConfig &&
    typeof adapterConfig === 'object' &&
    !Array.isArray(adapterConfig) &&
    (adapterConfig as Record<string, unknown>).harness === OPENCODE_HARNESS_KIND
  );
}

/**
 * Strict parse of an OpenCode bind. Throws OpencodeHarnessConfigError — a half-configured
 * OpenCode bind must fail the wake LOUDLY, never silently fall back to the in-product harness
 * (and never to the Hermes dispatcher).
 */
export function parseOpencodeHarnessBind(adapterConfig: unknown): OpencodeHarnessBind {
  const parsed = opencodeHarnessBindSchema.safeParse(adapterConfig);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new OpencodeHarnessConfigError(`Invalid OpenCode harness bind — ${detail}`);
  }
  return parsed.data;
}

/**
 * Origin the harness phones home to. Explicit bind.callbackBaseUrl wins (that is how a remote
 * harness gets a private LAN/Tailscale reachability URL — public exposure is deliberate).
 * Default keeps traffic local: INTERNAL_API_URL with `localhost` normalised to `127.0.0.1`,
 * origin only. Unparseable input falls back to loopback:3002.
 */
export function deriveOpencodeCallbackBaseUrl(
  callbackBaseUrl: string | undefined,
  internalApiUrl: string | undefined = process.env.INTERNAL_API_URL,
): string {
  const candidate = callbackBaseUrl ?? internalApiUrl;
  if (candidate) {
    try {
      const u = new URL(candidate);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        if (u.hostname.toLowerCase() === 'localhost') {
          return `${u.protocol}//127.0.0.1${u.port ? `:${u.port}` : ''}`;
        }
        return u.origin;
      }
    } catch {
      /* fall through to loopback default */
    }
  }
  return OPENCODE_DEFAULT_CALLBACK_ORIGIN;
}

export interface OpencodeHeartbeatCallback {
  baseUrl: string;
  sessionToken: string;
  endpoints: typeof OPENCODE_CALLBACK_PATHS;
}

export interface OpencodeHeartbeatEnvelope {
  kind: typeof OPENCODE_HEARTBEAT_KIND;
  version: typeof OPENCODE_HEARTBEAT_VERSION;
  runId: string;
  agentId: string;
  companyId: string;
  wakeReason: string;
  taskId?: string;
  goalId?: string;
  projectId?: string;
  prompt: string;
  callback: OpencodeHeartbeatCallback;
  /** Skill markdown that teaches the harness the heartbeat + callback protocol. */
  skillInstall: string;
}

export interface BuildOpencodeEnvelopeInput {
  runId: string;
  agentId: string;
  companyId: string;
  wakeReason: string;
  taskId?: string;
  goalId?: string;
  projectId?: string;
  prompt: string;
  /** Signed run-scoped session token (pm_run_…) — the harness authenticates with this. */
  sessionToken: string;
  /** Phone-home origin (never blank — a heartbeat WITHOUT callbackUrl is a bug). */
  callbackBaseUrl: string;
  skillInstall?: string;
}

function requireNonEmpty(value: string | undefined, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OpencodeHarnessConfigError(`OpenCode heartbeat missing required field '${field}'`);
  }
  return value;
}

/**
 * Build the heartbeat envelope. FAILS CLOSED: a heartbeat without a callbackUrl or session
 * token is a protocol violation (the harness could never phone home), so this throws before
 * anything is dispatched — pinned by the adapter tests.
 */
export function buildOpencodeHeartbeatEnvelope(
  input: BuildOpencodeEnvelopeInput,
): OpencodeHeartbeatEnvelope {
  const runId = requireNonEmpty(input.runId, 'runId');
  const agentId = requireNonEmpty(input.agentId, 'agentId');
  const companyId = requireNonEmpty(input.companyId, 'companyId');
  const prompt = requireNonEmpty(input.prompt, 'prompt');
  const sessionToken = requireNonEmpty(input.sessionToken, 'callback.sessionToken');
  const callbackBaseUrl = requireNonEmpty(input.callbackBaseUrl, 'callback.baseUrl');

  return {
    kind: OPENCODE_HEARTBEAT_KIND,
    version: OPENCODE_HEARTBEAT_VERSION,
    runId,
    agentId,
    companyId,
    wakeReason: requireNonEmpty(input.wakeReason, 'wakeReason'),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.goalId ? { goalId: input.goalId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    prompt,
    callback: {
      baseUrl: callbackBaseUrl,
      sessionToken,
      endpoints: { ...OPENCODE_CALLBACK_PATHS },
    },
    skillInstall: input.skillInstall?.trim() || OPENCODE_SKILL_INSTALL_MD,
  };
}

/**
 * Split an agent `modelId` of the OpenCode shape `provider/model` into the prompt-body
 * `model` object. Anything without a single `provider/model` shape → undefined (the server
 * uses the model configured as default for the session).
 */
export function opencodeModelFromModelId(
  modelId: string | undefined | null,
): { providerID: string; modelID: string } | undefined {
  if (!modelId) return undefined;
  const trimmed = modelId.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf('/');
  const providerID = trimmed.slice(0, slash).trim();
  const modelID = trimmed.slice(slash + 1).trim();
  if (slash <= 0 || !modelID) return undefined;
  return { providerID, modelID };
}

/**
 * `session.prompt` body for the envelope. The wake prompt rides as the text part (human
 * inspectable); the full envelope rides as a fenced ```json block appended to it (OpenCode
 * has no per-message metadata field) AND in `metadata.tourbillon` on the SESSION create
 * (machine-readable). Kind/version match the Hermes envelope contract.
 */
export function buildOpencodePromptText(envelope: OpencodeHeartbeatEnvelope): string {
  return [
    envelope.prompt,
    '',
    '---',
    'Tourbillon heartbeat envelope (parse this JSON and follow the tourbillon-agent skill):',
    '```json',
    JSON.stringify(envelope, null, 2),
    '```',
  ].join('\n');
}

export interface OpencodePromptBody {
  parts: Array<{ type: 'text'; text: string }>;
  model?: { providerID: string; modelID: string };
}

export function buildOpencodePromptBody(
  envelope: OpencodeHeartbeatEnvelope,
  modelId?: string | null,
): OpencodePromptBody {
  const model = opencodeModelFromModelId(modelId);
  return {
    parts: [{ type: 'text', text: buildOpencodePromptText(envelope) }],
    ...(model ? { model } : {}),
  };
}

/** `session.create` body — title + machine-readable metadata only (schema is additionalProperties:false). */
export function buildOpencodeSessionCreateBody(envelope: OpencodeHeartbeatEnvelope): {
  title: string;
  metadata: { tourbillon: Record<string, unknown> };
} {
  return {
    title: `tourbillon ${envelope.wakeReason} ${envelope.runId}`.slice(0, 120),
    metadata: {
      tourbillon: {
        kind: envelope.kind,
        version: envelope.version,
        runId: envelope.runId,
        agentId: envelope.agentId,
        companyId: envelope.companyId,
        wakeReason: envelope.wakeReason,
        ...(envelope.taskId ? { taskId: envelope.taskId } : {}),
      },
    },
  };
}

export type OpencodeFinish = 'complete' | 'error' | 'timeout';

/**
 * Map the synchronous `session.prompt` response to a wake finish reason. Measured on 1.18.35:
 * a successful assistant message carries `info.finish === "stop"`. Anything else (error,
 * unknown, missing) is an error — never a silent pass.
 */
export function opencodeFinishReasonFromPrompt(response: unknown): OpencodeFinish {
  const finish =
    response && typeof response === 'object'
      ? (response as { info?: { finish?: unknown } }).info?.finish
      : undefined;
  return finish === 'stop' ? 'complete' : 'error';
}

/** Extract token usage from a `session.prompt` response ({info:{tokens:{input,output}}}). */
export function opencodeTokensFromPrompt(response: unknown): { inputTokens: number; outputTokens: number } {
  const tokens =
    response && typeof response === 'object'
      ? (response as { info?: { tokens?: { input?: unknown; output?: unknown } } }).info?.tokens
      : undefined;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return { inputTokens: num(tokens?.input), outputTokens: num(tokens?.output) };
}

/**
 * Skill-install blob (OpenCode SKILL.md shape: YAML frontmatter name/description + body).
 * Single source of truth: shipped in the heartbeat envelope AND served at
 * GET {callback.baseUrl}{OPENCODE_CALLBACK_PATHS.skill}. Install locations that OpenCode
 * discovers (measured 1.18.35): `.opencode/skill/<name>/SKILL.md` in the project directory or
 * `~/.agents/skills/<name>/SKILL.md`.
 */
export const OPENCODE_SKILL_INSTALL_MD = `---
name: tourbillon-agent
description: Act as a Tourbillon agent over the direct harness connection. Use when woken by Tourbillon with a heartbeat envelope (kind "tourbillon.heartbeat") — via stdin/$TOURBILLON_WAKE_JSON (local command bind) or the fenced JSON envelope in the prompt text (opencode serve bind).
---

# Tourbillon agent heartbeat (OpenCode)

You are running as a Tourbillon agent. A wake arrives as a **heartbeat envelope**:

- Local command bind: JSON on stdin and in \`$TOURBILLON_WAKE_JSON\`;
  \`$TOURBILLON_CALLBACK_URL\` and \`$TOURBILLON_SESSION_TOKEN\` are also set.
- Server bind (\`opencode serve\`): the wake prompt text ends with a fenced \`\`\`json block
  labelled "Tourbillon heartbeat envelope" — parse it.

Envelope shape:

\`\`\`json
{
  "kind": "tourbillon.heartbeat",
  "runId": "...", "agentId": "...", "companyId": "...",
  "wakeReason": "timer", "taskId": "...",
  "prompt": "the wake message from Tourbillon",
  "callback": {
    "baseUrl": "http://127.0.0.1:3002",
    "sessionToken": "pm_run_...",
    "endpoints": { "toolsList": "...", "toolsCall": "...", "skill": "...", "chat": "..." }
  },
  "skillInstall": "<this document>"
}
\`\`\`

## Heartbeat loop

1. Read \`prompt\` — it is the wake (task context, recent comments, reason).
2. Do the work by calling Tourbillon tools over the callback (below).
3. When the prompt is satisfied (or blocked), stop. Tourbillon records the run; do NOT
   re-run the loop without a new wake.

## Tools (capability-gated — same rules as in-system agents)

Authenticate every callback with \`Authorization: Bearer <callb...>ver the tools (curl works fine):

- List what this agent may call: \`GET {callback.baseUrl}{toolsList}\`
- Call a tool: \`POST {callback.baseUrl}{toolsCall}\` with
  \`{ "tool": "<name>", "args": { ... } }\`

Tools include the control plane (getInbox, checkoutIssue, getComments, updateIssue,
createSubtask, …) plus whatever the agent's Tourbillon config grants (comments, approvals,
roster, DMs via sendToAgent, web search, MCP toolsets). A tool the agent is NOT allowed
returns 403 \`tool_not_permitted\` — never retry harder; pick other work or report the block.
Always checkoutIssue before working a task; write decisions to issue comments (comments are
the shared record); 409 on checkout means someone else holds the lock — choose another task.
When the task needs review, updateIssue to in_review with the reviewer assigned — do not
silently park work.

## Chat

Board chat is not exposed on this callback yet (501 \`chat_not_implemented\`).
For now, message other agents with the \`sendToAgent\` DM tool when the agent has it.

## Rules

- The session token is a secret: never print it, log it, put it in issue comments, or write it
  to files in the working directory.
- Only act as the agent in the envelope; the token is scoped to this run and expires with it.
- Do not edit OpenCode's own config, install MCP servers, or widen permissions as part of a
  wake — the harness is configured by the operator, not by the woken agent.
`;
