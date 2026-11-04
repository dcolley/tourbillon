/**
 * #281 — External Hermes harness adapter (scheduler side).
 *
 * Routes a heartbeat to an EXTERNAL Hermes instead of the in-product Mastra AgentController.
 * Selected by wake-runner when `isHermesHarnessBind(agentRecord.adapterConfig)` — the in-product
 * harness-adapter.ts is untouched.
 *
 * Two transports (from the parsed bind):
 *  - `command` (local CLI default): spawn the operator's command with the heartbeat envelope on
 *    stdin + $TOURBILLON_WAKE_JSON / $TOURBILLON_CALLBACK_URL / $TOURBILLON_SESSION_TOKEN.
 *  - `localBaseUrl` / `harnessBaseUrl` (HTTP): POST the A2A JSONRPC `message/send` body to the
 *    Hermes gateway origin, `Authorization: Bearer <apiToken>` when configured. (Hermes gateway
 *    verified live 2026-11-02: card at /.well-known/agent.json, JSONRPC binding, streaming
 *    capability; unauthenticated POST / → -32050 unauthorized.)
 *
 * INVARIANT (pinned by hermes-adapter.test.ts): EVERY dispatch — command OR HTTP, local OR
 * remote — carries callback.baseUrl + callback.sessionToken in the envelope. The envelope
 * builder throws on a missing session token or callback origin BEFORE any transport is touched,
 * so a homeless heartbeat can never be dispatched.
 *
 * Structurally compatible with HarnessRunResult from ./harness-adapter so wake-runner's
 * recordHarnessResult handles both. Token usage is 0 for this slice — external harnesses report
 * usage over the callback in a later pack.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  HERMES_WAKE_ENV,
  buildHermesA2aMessageSendRequest,
  buildHermesHeartbeatEnvelope,
  hermesA2aFinishReasonFromTask,
  type HermesHarnessBind,
  type HermesHeartbeatEnvelope,
} from '@tourbillon/shared/hermes-harness';
import type { HeartbeatJobData } from '@tourbillon/shared/types';

export type HermesFinishReason = 'complete' | 'error' | 'timeout';

export interface HermesDispatchResult {
  threadId: string;
  transport: 'command' | 'http';
  harnessRunId?: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: HermesFinishReason;
  /** Short operator-facing detail (never a token). */
  detail?: string;
}

export interface HermesDispatchContext {
  wake: HeartbeatJobData;
  wakeMessage: string;
  runId: string;
  /** Signed run-scoped token (#110) — the harness's session token for phoning home. */
  apiKey: string;
  goalId?: string;
  projectId?: string;
}

export interface HermesDispatchOptions {
  bind: HermesHarnessBind;
  /** Phone-home origin (derived via deriveHermesCallbackBaseUrl — never blank). */
  callbackBaseUrl: string;
  /** Effective wall-clock seconds for this wake (<=0 disables the timer). */
  timeoutSec: number;
  abortSignal?: AbortSignal;
  deps?: HermesDispatchDeps;
}

export interface HermesSpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Test seam: no real processes / sockets in unit tests. */
export interface HermesDispatchDeps {
  fetchImpl?: typeof fetch;
  spawnCommand?: (
    command: string,
    env: Record<string, string>,
    signal: AbortSignal,
  ) => Promise<HermesSpawnResult>;
  envelope?: HermesHeartbeatEnvelope; // test-only override; production always builds it
}

function envForEnvelope(envelope: HermesHeartbeatEnvelope): Record<string, string> {
  return {
    [HERMES_WAKE_ENV.wakeJson]: JSON.stringify(envelope),
    [HERMES_WAKE_ENV.callbackUrl]: envelope.callback.baseUrl,
    [HERMES_WAKE_ENV.sessionToken]: envelope.callback.sessionToken,
  };
}

/**
 * S331-3 (#331): MINIMAL spawn environment for harness children. The worker carries
 * DATABASE_URL, BETTER_AUTH_SECRET, TOURBILLON_AGENT_TOKEN_SECRET and friends — an operator's
 * `command` bind is third-party CLI glue and must never inherit them. The child gets exactly:
 *  - PATH (so the shell can resolve the operator's command; sane fallback when absent)
 *  - HOME  (CLIs look up ~/.config, ~/.hermes etc.; omitted when unset)
 *  - every var the adapter passes explicitly (the three TOURBILLON_* wake vars —
 *    wake JSON, callback URL, session token — spread LAST so they always win).
 * Object.assign (not a literal spread) keeps this assignable under apps/web's tsc too, where
 * Next's globals declare NODE_ENV required on ProcessEnv (TS2322 on spread-literal merges).
 */
export function harnessChildEnv(env: Record<string, string>): Record<string, string> {
  const minimal: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  };
  if (process.env.HOME) minimal.HOME = process.env.HOME;
  return Object.assign({}, minimal, env);
}

/** Default command transport: shell spawn, envelope on env + stdin, hard-stop on signal. */
export async function defaultSpawnCommand(
  command: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<HermesSpawnResult> {
  return await new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(command, {
      shell: true,
      env: harnessChildEnv(env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const cap = 64 * 1024;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < cap) stdout += chunk.toString('utf8').slice(0, cap - stdout.length);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < cap) stderr += chunk.toString('utf8').slice(0, cap - stderr.length);
    });
    // The envelope also rides stdin for harnesses that read stdin instead of env.
    // NIT-2 (#335 review) hardening, two parts, both proven by hermes-adapter-spawn-env.test.ts:
    //  - wakeJson is always set by the adapters' env builder, but an un-guarded
    //    write(undefined) throws inside the executor and rejects the dispatch; '' keeps it total.
    //  - The stdin envelope is BEST-EFFORT: a CLI that never reads stdin (or exits fast, e.g.
    //    `true`) closes the pipe and the write EPIPEs — an unhandled stream error would reject
    //    an otherwise-successful dispatch. The env vars still carry the full envelope.
    child.stdin?.on('error', () => {});
    child.stdin?.write(env[HERMES_WAKE_ENV.wakeJson] ?? '');
    child.stdin?.end();
    const kill = () => child.kill('SIGKILL');
    if (signal.aborted) kill();
    else signal.addEventListener('abort', kill, { once: true });
    child.once('error', (err) => {
      signal.removeEventListener('abort', kill);
      reject(err);
    });
    child.once('close', (code) => {
      signal.removeEventListener('abort', kill);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

/** Resolve the A2A HTTP target origin for the bind (remote wins; local uses loopback base). */
export function hermesHttpTargetOrigin(bind: HermesHarnessBind): string {
  return bind.mode === 'remote' ? (bind.harnessBaseUrl as string) : (bind.localBaseUrl as string);
}

/**
 * Dispatch one heartbeat to the external Hermes. Throws HermesHarnessConfigError (from the
 * envelope builder) when the callback contract is incomplete — before touching any transport.
 */
export async function dispatchHermesHeartbeat(
  context: HermesDispatchContext,
  options: HermesDispatchOptions,
): Promise<HermesDispatchResult> {
  const { bind, callbackBaseUrl, timeoutSec, abortSignal } = options;
  const deps = options.deps ?? {};
  const { wake, wakeMessage, runId, apiKey } = context;

  // FAILS CLOSED here when sessionToken/callbackBaseUrl are blank — pinned by tests.
  const envelope =
    deps.envelope ??
    buildHermesHeartbeatEnvelope({
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
    threadId: `hermes-${runId}`,
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

    // ---- Transport 2: Hermes HTTP (A2A JSONRPC message/send) ------------------------
    const target = hermesHttpTargetOrigin(bind);
    if (!target) {
      return { ...baseResult, transport: 'http', finishReason: 'error', detail: 'no Hermes base URL on bind' };
    }
    const fetchImpl = deps.fetchImpl ?? fetch;
    const request = buildHermesA2aMessageSendRequest(envelope, randomUUID());
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (bind.apiToken) headers.Authorization = `Bearer ${bind.apiToken}`;

    let response: Response;
    try {
      response = await fetchImpl(target, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: hardStop.signal,
      });
    } catch (err) {
      if (timedOut || wakeAborted || hardStop.signal.aborted) {
        return {
          ...baseResult,
          transport: 'http',
          finishReason: 'timeout',
          detail: timedOut ? 'hermes request wall-clock exceeded' : 'wake aborted',
        };
      }
      return {
        ...baseResult,
        transport: 'http',
        finishReason: 'error',
        detail: `fetch: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!response.ok) {
      return {
        ...baseResult,
        transport: 'http',
        finishReason: 'error',
        detail: `hermes gateway HTTP ${response.status}`,
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ...baseResult, transport: 'http', finishReason: 'error', detail: 'hermes gateway returned non-JSON' };
    }
    const rpc = (body ?? {}) as {
      result?: { id?: unknown; status?: { state?: unknown } };
      error?: { code?: unknown; message?: unknown };
    };
    if (rpc.error) {
      return {
        ...baseResult,
        transport: 'http',
        finishReason: 'error',
        detail: `jsonrpc ${String(rpc.error.code ?? '?')}: ${String(rpc.error.message ?? 'error')}`,
      };
    }
    const finish = hermesA2aFinishReasonFromTask(rpc.result);
    const state = rpc.result?.status?.state;
    return {
      ...baseResult,
      transport: 'http',
      harnessRunId: typeof rpc.result?.id === 'string' ? rpc.result.id : undefined,
      finishReason: finish,
      detail: finish === 'error' ? `a2a state ${String(state ?? 'unknown')}` : undefined,
    };
  } finally {
    if (timer) clearTimeout(timer);
    abortSignal?.removeEventListener('abort', onWakeAbort);
  }
}
