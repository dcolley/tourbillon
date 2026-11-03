/**
 * #281 — Hermes direct harness connection (first slice).
 *
 * Binds a Tourbillon agent to an EXTERNAL Hermes harness. The bind lives entirely in
 * `agents.adapterConfig` (jsonb) — no migration, no new adapterType enum. A Hermes-bound agent
 * keeps `adapterType = 'harness_local'` (UI/runtime class "Harness"); the discriminator is
 * `adapterConfig.harness === 'hermes'`. Agents without that key are the in-product
 * Mastra AgentController harness, untouched by this module.
 *
 * Product lock (docs/backlog/harness-direct-connection.md):
 *  - One MCP/API surface. Principal = token. External tool calls run the SAME capability gate
 *    as in-system agents (apps/web/lib/harness/callback-gate.ts).
 *  - Local bind is the default (command and/or loopback baseUrl). Remote is opt-in and demands
 *    `harnessBaseUrl` + `apiToken`.
 *  - EVERY heartbeat (local and remote) stamps `callback.baseUrl` + `callback.sessionToken` so
 *    Hermes phones home. Privacy default: loopback callback (http://127.0.0.1:<port>/…).
 *
 * The remote/local-HTTP leg speaks the A2A JSONRPC surface that the Hermes gateway publishes
 * (agent card at `/.well-known/agent.json`, `supportedInterfaces[].protocolBinding = "JSONRPC"`,
 * `capabilities.streaming = true`; unauthenticated POST / returns JSONRPC -32050 "unauthorized"
 * — measured on the live hermes-vm gateway 2026-11-02). Heartbeats send `message/send` (sync).
 * AC5 chat: the callback chat endpoint speaks the same A2A JSONRPC (`message/send` /
 * `message/stream`) when the bind advertises `chat` (see ./harness-chat.ts).
 *
 * Never log `apiToken` or `sessionToken`.
 */
import { z } from 'zod';
import { harnessChatCapabilitySchema } from './harness-chat';

/** adapterConfig discriminator for the external Hermes bind. */
export const HERMES_HARNESS_KIND = 'hermes' as const;

/** Envelope discriminator carried to the harness on every heartbeat. */
export const HERMES_HEARTBEAT_KIND = 'tourbillon.heartbeat' as const;
export const HERMES_HEARTBEAT_VERSION = 1 as const;

/** Env vars set on a local `command` spawn so a CLI harness can read the wake. */
export const HERMES_WAKE_ENV = {
  wakeJson: 'TOURBILLON_WAKE_JSON',
  callbackUrl: 'TOURBILLON_CALLBACK_URL',
  sessionToken: 'TOURBILLON_SESSION_TOKEN',
} as const;

/** Tourbillon callback endpoints the skill teaches the harness to call. */
export const HERMES_CALLBACK_PATHS = {
  toolsList: '/api/harness/callback/tools',
  toolsCall: '/api/harness/callback/tools/call',
  skill: '/api/harness/callback/skill',
  chat: '/api/harness/callback/chat',
} as const;

/** Fallback callback origin when INTERNAL_API_URL is unset/unparseable (port 3002 = web app). */
export const HERMES_DEFAULT_CALLBACK_ORIGIN = 'http://127.0.0.1:3002';

/** Remote api tokens below this length are almost certainly typos; reject at save time. */
export const HERMES_REMOTE_API_TOKEN_MIN_LENGTH = 16;

export class HermesHarnessConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HermesHarnessConfigError';
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

export const hermesHarnessBindSchema = z
  .object({
    harness: z.literal(HERMES_HARNESS_KIND),
    mode: z.enum(['local', 'remote']),
    /** Local CLI: shell command that starts Hermes and reads the wake from stdin/env. */
    command: z.string().min(1).optional(),
    /** Local API: loopback Hermes (A2A JSONRPC) origin. */
    localBaseUrl: localLoopbackUrl.optional(),
    /** Remote Hermes gateway origin (private reachability path; public URLs are operator opt-in). */
    harnessBaseUrl: httpOriginUrl.optional(),
    /** Bearer token for the remote (or key-gated local) Hermes API. */
    apiToken: z.string().min(1).optional(),
    /** Override the phone-home origin; default is loopback derived from INTERNAL_API_URL. */
    callbackBaseUrl: httpOriginUrl.optional(),
    /** Replace the bundled skill-install blob served at the callback `skill` endpoint. */
    skillInstall: z.string().min(1).optional(),
    /** AC5: chat legs this harness advertises (absent ⇒ callback chat refused). */
    chat: harnessChatCapabilitySchema.optional(),
  })
  .strict()
  .superRefine((bind, ctx) => {
    if (bind.mode === 'local') {
      if (!bind.command && !bind.localBaseUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['command'],
          message: "local Hermes bind needs 'command' and/or loopback 'localBaseUrl'",
        });
      }
    } else {
      if (!bind.harnessBaseUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['harnessBaseUrl'],
          message: "remote Hermes bind requires 'harnessBaseUrl'",
        });
      }
      if (!bind.apiToken || bind.apiToken.trim().length < HERMES_REMOTE_API_TOKEN_MIN_LENGTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['apiToken'],
          message: `remote Hermes bind requires 'apiToken' of at least ${HERMES_REMOTE_API_TOKEN_MIN_LENGTH} chars`,
        });
      }
    }
  });

export type HermesHarnessBind = z.infer<typeof hermesHarnessBindSchema>;

/** Cheap discriminator: does this adapterConfig declare an external Hermes bind? */
export function isHermesHarnessBind(adapterConfig: unknown): boolean {
  return (
    !!adapterConfig &&
    typeof adapterConfig === 'object' &&
    !Array.isArray(adapterConfig) &&
    (adapterConfig as Record<string, unknown>).harness === HERMES_HARNESS_KIND
  );
}

/**
 * Strict parse of a Hermes bind. Throws HermesHarnessConfigError — a half-configured Hermes
 * bind must fail the wake LOUDLY, never silently fall back to the in-product harness.
 */
export function parseHermesHarnessBind(adapterConfig: unknown): HermesHarnessBind {
  const parsed = hermesHarnessBindSchema.safeParse(adapterConfig);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new HermesHarnessConfigError(`Invalid Hermes harness bind — ${detail}`);
  }
  return parsed.data;
}

/**
 * Origin the harness phones home to. Explicit bind.callbackBaseUrl wins (that is how a remote
 * harness gets a private LAN/Tailscale reachability URL — public exposure is deliberate).
 * Default keeps traffic local: INTERNAL_API_URL with `localhost` normalised to `127.0.0.1`,
 * origin only. Unparseable input falls back to loopback:3002.
 */
export function deriveHermesCallbackBaseUrl(
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
  return HERMES_DEFAULT_CALLBACK_ORIGIN;
}

export interface HermesHeartbeatCallback {
  baseUrl: string;
  sessionToken: string;
  endpoints: typeof HERMES_CALLBACK_PATHS;
}

export interface HermesHeartbeatEnvelope {
  kind: typeof HERMES_HEARTBEAT_KIND;
  version: typeof HERMES_HEARTBEAT_VERSION;
  runId: string;
  agentId: string;
  companyId: string;
  wakeReason: string;
  taskId?: string;
  goalId?: string;
  projectId?: string;
  prompt: string;
  callback: HermesHeartbeatCallback;
  /** Skill markdown that teaches the harness the heartbeat + callback protocol. */
  skillInstall: string;
}

export interface BuildHermesEnvelopeInput {
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
    throw new HermesHarnessConfigError(`Hermes heartbeat missing required field '${field}'`);
  }
  return value;
}

/**
 * Build the heartbeat envelope. FAILS CLOSED: a heartbeat without a callbackUrl or session
 * token is a protocol violation (the harness could never phone home), so this throws before
 * anything is dispatched — pinned by the adapter tests.
 */
export function buildHermesHeartbeatEnvelope(input: BuildHermesEnvelopeInput): HermesHeartbeatEnvelope {
  const runId = requireNonEmpty(input.runId, 'runId');
  const agentId = requireNonEmpty(input.agentId, 'agentId');
  const companyId = requireNonEmpty(input.companyId, 'companyId');
  const prompt = requireNonEmpty(input.prompt, 'prompt');
  const sessionToken = requireNonEmpty(input.sessionToken, 'callback.sessionToken');
  const callbackBaseUrl = requireNonEmpty(input.callbackBaseUrl, 'callback.baseUrl');

  return {
    kind: HERMES_HEARTBEAT_KIND,
    version: HERMES_HEARTBEAT_VERSION,
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
      endpoints: { ...HERMES_CALLBACK_PATHS },
    },
    skillInstall: input.skillInstall?.trim() || HERMES_SKILL_INSTALL_MD,
  };
}

/**
 * A2A `message/send` JSONRPC body for the envelope. The prompt goes in the text part (human
 * inspectable); the full envelope rides in message.metadata.tourbillon (machine contract).
 */
export function buildHermesA2aMessageSendRequest(
  envelope: HermesHeartbeatEnvelope,
  messageId: string,
): {
  jsonrpc: '2.0';
  id: string;
  method: 'message/send';
  params: {
    message: {
      kind: 'message';
      role: 'user';
      messageId: string;
      parts: Array<{ kind: 'text'; text: string }>;
      metadata: { tourbillon: HermesHeartbeatEnvelope };
    };
  };
} {
  return {
    jsonrpc: '2.0',
    id: envelope.runId,
    method: 'message/send',
    params: {
      message: {
        kind: 'message',
        role: 'user',
        messageId,
        parts: [{ kind: 'text', text: envelope.prompt }],
        metadata: { tourbillon: envelope },
      },
    },
  };
}

export type HermesA2aFinish = 'complete' | 'error' | 'timeout';

/**
 * Map an A2A task to a wake finish reason. Only terminal `completed` counts as success;
 * failed/rejected are errors; anything non-terminal (working/submitted/input-required —
 * push-notification resumes are not implemented in this slice) is an error, not a silent pass.
 */
export function hermesA2aFinishReasonFromTask(task: unknown): HermesA2aFinish {
  const state =
    task && typeof task === 'object'
      ? (task as { status?: { state?: unknown } }).status?.state
      : undefined;
  if (state === 'completed') return 'complete';
  return 'error';
}

/**
 * Skill-install blob (Hermes SKILL.md shape). Single source of truth: shipped in the heartbeat
 * envelope AND served at GET {callback.baseUrl}{HERMES_CALLBACK_PATHS.skill}.
 */
export const HERMES_SKILL_INSTALL_MD = `---
name: tourbillon-agent
description: Act as a Tourbillon agent over the direct harness connection. Use when woken by Tourbillon with a heartbeat envelope (kind "tourbillon.heartbeat") — via stdin/$TOURBILLON_WAKE_JSON (local command bind) or A2A message metadata .tourbillon (HTTP bind).
---

# Tourbillon agent heartbeat

You are running as a Tourbillon agent. A wake arrives as a **heartbeat envelope**:

- Local command bind: JSON on stdin and in \`$TOURBILLON_WAKE_JSON\`;
  \`$TOURBILLON_CALLBACK_URL\` and \`$TOURBILLON_SESSION_TOKEN\` are also set.
- HTTP bind: the envelope is at A2A \`message.metadata.tourbillon\`.

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

Authenticate every callback with \`Authorization: Bearer <callback.sessionToken>\`.

- List what this agent may call: \`GET {callback.baseUrl}{toolsList}\`
- Call a tool: \`POST {callback.baseUrl}{toolsCall}\` with
  \`{ "tool": "<name>", "args": { ... } }\`

Tools include the control plane (getInbox, checkoutIssue, getComments, updateIssue,
createSubtask, …) plus whatever the agent's Tourbillon config grants (comments, approvals,
roster, DMs via sendToAgent, web search, MCP toolsets). A tool the agent is NOT allowed
returns 403 \`tool_not_permitted\` — never retry harder; pick other work or report the block.
Always checkoutIssue before working a task; write decisions to issue comments (comments are
the shared record); 409 on checkout means someone else holds the lock — choose another task.

## Chat (only when your bind advertises it)

If the operator set \`chat\` on your bind (\`{ "sync": true }\` and/or \`{ "stream": true }\`), you
can chat with another Tourbillon agent over A2A JSONRPC at \`POST {callback.baseUrl}{chat}\`
(same Bearer session token):

\`\`\`json
{ "jsonrpc": "2.0", "id": "1", "method": "message/send",
  "params": { "message": { "role": "user", "parts": [{ "kind": "text", "text": "…" }],
    "metadata": { "tourbillon": { "toAgentUrlKey": "cto" } } } } }
\`\`\`

- \`message/send\` needs \`chat.sync\`; \`message/stream\` needs \`chat.stream\` and answers as
  \`text/event-stream\` (status working → agent message → final status).
- Delivery runs your gated \`sendToAgent\` DM tool: 403 \`chat_not_permitted\` when DMs are not
  granted (never retry harder). 409 \`chat_not_supported\` / \`chat_*_not_supported\` means the
  bind does not advertise that leg — use \`sendToAgent\` via tools/call or issue comments.
- Board chat stays in Tourbillon's own chat UI; reach the Board through issue comments.

## Rules

- The session token is a secret: never print it, log it, or put it in issue comments.
- Only act as the agent in the envelope; the token is scoped to this run and expires with it.
`;
