/**
 * #281 — External OpenCode harness adapter (scheduler side).
 *
 * Routes a heartbeat to an EXTERNAL OpenCode instead of the in-product Mastra AgentController.
 * Selected by wake-runner when `isOpencodeHarnessBind(agentRecord.adapterConfig)` — the
 * in-product harness-adapter.ts and the Hermes adapter are untouched by this file. A malformed
 * OpenCode bind fails the wake LOUDLY (parseOpencodeHarnessBind throws); there is never a
 * silent fallback to AgentController or the Hermes dispatcher.
 *
 * Two transports (from the parsed bind):
 *  - `command` (local CLI default): spawn the operator's command with the heartbeat envelope on
 *    stdin + $TOURBILLON_WAKE_JSON / $TOURBILLON_CALLBACK_URL / $TOURBILLON_SESSION_TOKEN
 *    (same env contract as the Hermes bind — a wrapper script can serve either harness).
 *  - `localBaseUrl` / `harnessBaseUrl` (HTTP): drive the measured `opencode serve` REST API
 *    (1.18.35, GET /doc OpenAPI):
 *      1. POST /session {title, metadata.tourbillon}      → { id: "ses_…" }
 *      2. POST /session/{id}/message {model?, parts}      → { info: AssistantMessage, parts }
 *         sync; `info.finish === "stop"` is the only pass; `info.tokens` feeds usage.
 *    When an apiToken is configured the request carries an Authorization header (Bearer scheme);
 *    bearer auth (it gates on OPENCODE_SERVER_PASSWORD basic auth, see module docs in
 *    @tourbillon/shared/opencode-harness), so remote binds sit behind an operator-managed
 *    authenticating proxy that validates the token.
 *
 * INVARIANT (pinned by opencode-adapter.test.ts): EVERY dispatch — command OR HTTP, local OR
 * remote — carries callback.baseUrl + callback.sessionToken in the envelope. The envelope
 * builder throws on a missing session token or callback origin BEFORE any transport is touched,
 * so a homeless heartbeat can never be dispatched.
 *
 * Structurally compatible with HarnessRunResult from ./harness-adapter so wake-runner's
 * recordHarnessResult handles both. Token usage comes from the measured sync prompt response
 * (info.tokens); the command transport reports 0 (later pack: usage over the callback).
 */
import {
  buildOpencodeHeartbeatEnvelope,
  buildOpencodePromptBody,
  buildOpencodeSessionCreateBody,
  opencodeFinishReasonFromPrompt,
  opencodeTokensFromPrompt,
  OPENCODE_WAKE_ENV,
  type OpencodeHarnessBind,
  type OpencodeHeartbeatEnvelope,
} from '@tourbillon/shared/opencode-harness';
import { defaultSpawnCommand, type HermesSpawnResult } from './hermes-adapter';
import type { HeartbeatJobData } from '@tourbillon/shared/types';

export type OpencodeFinishReason = 'complete' | 'error' | 'timeout';

export interface OpencodeDispatchResult {
  threadId: string;
  transport: 'command' | 'http';
  /** OpenCode session id (ses_…) for HTTP dispatches. */
  harnessRunId?: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: OpencodeFinishReason;
  /** Short operator-facing detail (never a token). */
  detail?: string;
}

export interface OpencodeDispatchContext {
  wake: HeartbeatJobData;
  wakeMessage: string;
  runId: string;
  /** Signed run-scoped token (#110) — the harness's session token for phoning home. */
  apiKey: string;
  goalId?: string;
  projectId?: string;
  /** Agent modelId in OpenCode shape `provider/model`; omit to use the server default. */
  modelId?: string | null;
}

export interface OpencodeDispatchOptions {
  bind: OpencodeHarnessBind;
  /** Phone-home origin (derived via deriveOpencodeCallbackBaseUrl — never blank). */
  callbackBaseUrl: string;
  /** Effective wall-clock seconds for this wake (<=0 disables the timer). */
  timeoutSec: number;
  abortSignal?: AbortSignal;
  deps?: OpencodeDispatchDeps;
}

/** Test seam: no real processes / sockets in unit tests. */
export interface OpencodeDispatchDeps {
  fetchImpl?: typeof fetch;
  spawnCommand?: (
    command: string,
    env: Record<string, string>,
    signal: AbortSignal,
  ) => Promise<HermesSpawnResult>;
  envelope?: OpencodeHeartbeatEnvelope; // test-only override; production always builds it
}

function envForEnvelope(envelope: OpencodeHeartbeatEnvelope): Record<string, string> {
  return {
    [OPENCODE_WAKE_ENV.wakeJson]: JSON.stringify(envelope),
    [OPENCODE_WAKE_ENV.callbackUrl]: envelope.callback.baseUrl,
    [OPENCODE_WAKE_ENV.sessionToken]: envelope.callback.sessionToken,
  };
}

/** Resolve the `opencode serve` HTTP target origin for the bind (remote wins; local uses loopback base). */
export function opencodeHttpTargetOrigin(bind: OpencodeHarnessBind): string {
  return bind.mode === 'remote' ? (bind.harnessBaseUrl as string) : (bind.localBaseUrl as string);
}

interface JsonCall {
  status: number;
  body: unknown;
}

/**
 * Dispatch one heartbeat to the external OpenCode. Throws OpencodeHarnessConfigError (from the
 * envelope builder) when the callback contract is incomplete — before touching any transport.
 */
export async function dispatchOpencodeHeartbeat(
  context: OpencodeDispatchContext,
  options: OpencodeDispatchOptions,
): Promise<OpencodeDispatchResult> {
  const { bind, callbackBaseUrl, timeoutSec, abortSignal } = options;
  const deps = options.deps ?? {};
  const { wake, wakeMessage, runId, apiKey } = context;

  // FAILS CLOSED here when sessionToken/callbackBaseUrl are blank — pinned by tests.
  const envelope =
    deps.envelope ??
    buildOpencodeHeartbeatEnvelope({
      runId,
      agentId: wake.agentId,
      companyId: wake.companyId,
      wakeReason: wake.wakeReason,
      taskId: wake.taskId,
      goalId: context.goalId,
      projectId: context.projectId,
      prompt: wakeMessage,
      sessionToken: apiKey,
      callbackBaseUrl,
      skillInstall: bind.skillInstall,
    });

  const baseResult = {
    threadId: `opencode-${runId}`,
    inputTokens: 0,
    outputTokens: 0,
  };

  // One hard-stop signal fed by BOTH the wall clock and the operator/wake abort.
  let timedOut = false;
  let wakeAborted = false;
  const hardStop = new AbortController();
  const onWakeAbort = () => {
    wakeAborted = true;
    hardStop.abort();
  };
  abortSignal?.addEventListener('abort', onWakeAbort, { once: true });
  const timer =
    timeoutSec > 0
      ? setTimeout(() => {
          timedOut = true;
          hardStop.abort();
        }, timeoutSec * 1000)
      : undefined;

  const timeoutDetail = () => (timedOut ? 'opencode request wall-clock exceeded' : 'wake aborted');

  try {
    // ---- Transport 1: local CLI command ----------------------------------------------
    if (bind.command) {
      const spawnCommand = deps.spawnCommand ?? defaultSpawnCommand;
      let spawned: HermesSpawnResult | undefined;
      let spawnError: unknown;
      try {
        spawned = await spawnCommand(bind.command, envForEnvelope(envelope), hardStop.signal);
      } catch (err) {
        spawnError = err;
      }
      if (timedOut) {
        return {
          ...baseResult,
          transport: 'command',
          finishReason: 'timeout',
          detail: 'command wall-clock exceeded',
        };
      }
      if (wakeAborted) {
        return { ...baseResult, transport: 'command', finishReason: 'timeout', detail: 'wake aborted' };
      }
      if (spawnError) {
        return {
          ...baseResult,
          transport: 'command',
          finishReason: 'error',
          detail: `spawn: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`,
        };
      }
      const value = spawned ?? { exitCode: 1, stdout: '', stderr: 'no result' };
      if (value.exitCode !== 0) {
        const detail = (value.stderr || value.stdout || '').slice(0, 500).trim();
        return {
          ...baseResult,
          transport: 'command',
          finishReason: 'error',
          detail: `command exit ${value.exitCode}${detail ? `: ${detail}` : ''}`,
        };
      }
      return { ...baseResult, transport: 'command', finishReason: 'complete' };
    }

    // ---- Transport 2: OpenCode HTTP (measured `opencode serve` REST API) --------------
    const target = opencodeHttpTargetOrigin(bind);
    if (!target) {
      return { ...baseResult, transport: 'http', finishReason: 'error', detail: 'no OpenCode base URL on bind' };
    }
    const fetchImpl = deps.fetchImpl ?? fetch;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (bind.apiToken) headers.Authorization = `Bearer ${bind.apiToken}`;

    const call = async (path: string, body: unknown): Promise<JsonCall> => {
      const response = await fetchImpl(`${target}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: hardStop.signal,
      });
      if (!response.ok) {
        return { status: response.status, body: null };
      }
      try {
        return { status: response.status, body: await response.json() };
      } catch {
        return { status: response.status, body: 'NON_JSON' };
      }
    };

    // 1) session create (machine-readable envelope rides in metadata.tourbillon)
    let session: { body: unknown };
    try {
      session = await call('/session', buildOpencodeSessionCreateBody(envelope));
    } catch (err) {
      if (timedOut || wakeAborted || hardStop.signal.aborted) {
        return { ...baseResult, transport: 'http', finishReason: 'timeout', detail: timeoutDetail() };
      }
      return {
        ...baseResult,
        transport: 'http',
        finishReason: 'error',
        detail: `session create fetch: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (session.status !== 200) {
      return {
        ...baseResult,
        transport: 'http',
        finishReason: 'error',
        detail: `opencode session create HTTP ${session.status}`,
      };
    }
    const sessionId = (session.body as { id?: unknown } | null)?.id;
    if (typeof sessionId !== 'string' || !sessionId.startsWith('ses')) {
      return { ...baseResult, transport: 'http', finishReason: 'error', detail: 'opencode session create returned no session id' };
    }

    const sessionResult = { ...baseResult, harnessRunId: sessionId };

    // 2) sync prompt (the envelope also rides in the prompt text as fenced JSON — OpenCode
    //    messages have no per-message metadata field; measured 1.18.35)
    const promptBody = buildOpencodePromptBody(envelope, context.modelId);
    let prompt: JsonCall;
    try {
      prompt = await call(`/session/${encodeURIComponent(sessionId)}/message`, promptBody);
    } catch (err) {
      if (timedOut || wakeAborted || hardStop.signal.aborted) {
        return { ...sessionResult, transport: 'http', finishReason: 'timeout', detail: timeoutDetail() };
      }
      return {
        ...sessionResult,
        transport: 'http',
        finishReason: 'error',
        detail: `prompt fetch: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (prompt.status !== 200) {
      return {
        ...sessionResult,
        transport: 'http',
        finishReason: 'error',
        detail: `opencode prompt HTTP ${prompt.status}`,
      };
    }
    if (prompt.body === 'NON_JSON') {
      return { ...sessionResult, transport: 'http', finishReason: 'error', detail: 'opencode prompt returned non-JSON' };
    }

    const finish = opencodeFinishReasonFromPrompt(prompt.body);
    const tokens = opencodeTokensFromPrompt(prompt.body);
    const rawFinish = (prompt.body as { info?: { finish?: unknown } } | null)?.info?.finish;
    return {
      ...sessionResult,
      transport: 'http',
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      finishReason: finish,
      detail: finish === 'error' ? `opencode info.finish ${String(rawFinish ?? 'unknown')}` : undefined,
    };
  } finally {
    if (timer) clearTimeout(timer);
    abortSignal?.removeEventListener('abort', onWakeAbort);
  }
}
