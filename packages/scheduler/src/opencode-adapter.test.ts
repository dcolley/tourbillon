/**
 * #281 OpenCode adapter — behaviour pins:
 *  1. A heartbeat with no session token / no callback origin must FAIL before any transport
 *     is touched (deps would explode if called).
 *  2. Every dispatch — command or HTTP, local or remote — carries callback.baseUrl +
 *     callback.sessionToken (env/stdin for command; fenced envelope JSON + session metadata
 *     for the measured opencode serve REST calls).
 *  3. Capability-boundary transport outcomes: session-create non-2xx, prompt non-2xx,
 *     non-"stop" finish, non-zero exit, wall-clock timeout, wake abort.
 *  4. NEVER falls through to a Hermes/A2A code path: this module only ever issues the two
 *     measured OpenCode POSTs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpencodeHarnessConfigError } from '@tourbillon/shared/opencode-harness';
import {
  dispatchOpencodeHeartbeat,
  opencodeHttpTargetOrigin,
  type OpencodeDispatchContext,
  type OpencodeDispatchDeps,
} from './adapters/opencode-adapter';

const REMOTE_TOKEN = 'tok-0123456789abcdef0';
const SESSION_TOKEN = 'pm_ru' + 'n_session_token';

function context(overrides: Partial<OpencodeDispatchContext> = {}): OpencodeDispatchContext {
  return {
    wake: {
      agentId: 'agent-1',
      companyId: 'company-1',
      invocationSource: 'timer',
      wakeReason: 'timer',
      taskId: 'issue-1',
    },
    wakeMessage: 'WAKE PROMPT',
    runId: 'run-1',
    apiKey: SESSION_TOKEN,
    modelId: 'lmstudio/qwen3.8-flash-next',
    ...overrides,
  };
}

const localCommandBind = { harness: 'opencode' as const, mode: 'local' as const, command: 'opencode run' };
const localHttpBind = { harness: 'opencode' as const, mode: 'local' as const, localBaseUrl: 'http://127.0.0.1:4096' };
const remoteBind = {
  harness: 'opencode' as const,
  mode: 'remote' as const,
  harnessBaseUrl: 'http://100.105.50.60:4096',
  apiToken: REMOTE_TOKEN,
};

const neverCalled = (): never => {
  throw new Error('transport must NOT be touched when the heartbeat contract is incomplete');
};

function promptResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      info: {
        id: 'msg_1',
        role: 'assistant',
        sessionID: 'ses_probe',
        finish: 'stop',
        tokens: { input: 8229, output: 4, reasoning: 17, total: 8250 },
        cost: 0,
      },
      parts: [{ type: 'text', text: 'PONG' }],
      ...overrides,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

test('PIN: missing session token fails closed — no transport touched', async () => {
  await assert.rejects(
    dispatchOpencodeHeartbeat(context({ apiKey: '' }), {
      bind: localCommandBind,
      callbackBaseUrl: 'http://127.0.0.1:3002',
      timeoutSec: 5,
      deps: { spawnCommand: neverCalled, fetchImpl: neverCalled as unknown as typeof fetch },
    }),
    OpencodeHarnessConfigError,
  );
});

test('PIN: missing callback origin fails closed — no transport touched', async () => {
  await assert.rejects(
    dispatchOpencodeHeartbeat(context(), {
      bind: localCommandBind,
      callbackBaseUrl: '   ',
      timeoutSec: 5,
      deps: { spawnCommand: neverCalled, fetchImpl: neverCalled as unknown as typeof fetch },
    }),
    OpencodeHarnessConfigError,
  );
});

// NOTE (S316-S2, Refs #316): the remote apiToken >=16 and loopback-only
// localBaseUrl rules are enforced at BIND PARSE (wake-runner parses the
// adapterConfig via parseOpencodeHarnessBind before the adapter is entered), so
// they are pinned in packages/shared/src/opencode-harness.test.ts at the parse
// boundary — the adapter below receives an already-validated bind.

test('command bind: envelope + callback reach the spawn env and stdin', async () => {
  let seenEnv: Record<string, string> | undefined;
  const result = await dispatchOpencodeHeartbeat(context(), {
    bind: localCommandBind,
    callbackBaseUrl: 'http://127.0.0.1:3002',
    timeoutSec: 30,
    deps: {
      spawnCommand: async (_cmd, env) => {
        seenEnv = env;
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
    },
  });
  assert.equal(result.finishReason, 'complete');
  assert.equal(result.transport, 'command');
  assert.equal(result.threadId, 'opencode-run-1');
  assert.equal(seenEnv?.TOURBILLON_CALLBACK_URL, 'http://127.0.0.1:3002');
  assert.equal(seenEnv?.TOURBILLON_SESSION_TOKEN, SESSION_TOKEN);
  const wake = JSON.parse(seenEnv?.TOURBILLON_WAKE_JSON ?? '{}');
  assert.equal(wake.kind, 'tourbillon.heartbeat');
  assert.equal(wake.callback.baseUrl, 'http://127.0.0.1:3002');
  assert.equal(wake.callback.sessionToken, SESSION_TOKEN);
  assert.equal(wake.prompt, 'WAKE PROMPT');
  assert.equal(wake.taskId, 'issue-1');
  assert.ok(wake.skillInstall.includes('name: tourbillon-agent'));
});

test('command bind: non-zero exit is a failed wake, not a silent success', async () => {
  const result = await dispatchOpencodeHeartbeat(context(), {
    bind: localCommandBind,
    callbackBaseUrl: 'http://127.0.0.1:3002',
    timeoutSec: 30,
    deps: { spawnCommand: async () => ({ exitCode: 3, stdout: '', stderr: 'boom' }) },
  });
  assert.equal(result.finishReason, 'error');
  assert.match(result.detail ?? '', /exit 3/);
  assert.match(result.detail ?? '', /boom/);
});

test('command bind: wall-clock timeout aborts the command and reports timeout', async () => {
  const result = await dispatchOpencodeHeartbeat(context(), {
    bind: localCommandBind,
    callbackBaseUrl: 'http://127.0.0.1:3002',
    timeoutSec: 0.05,
    deps: {
      spawnCommand: (_cmd, _env, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ exitCode: 137, stdout: '', stderr: 'killed' }), {
            once: true,
          });
        }),
    },
  });
  assert.equal(result.finishReason, 'timeout');
});

test('http bind (local loopback): session create + sync prompt carry the callback contract', async () => {
  const calls: { url: string; headers?: Record<string, string>; body?: Record<string, unknown> }[] = [];
  const fakeFetch = (async (u: unknown, init: RequestInit) => {
    const url = String(u);
    calls.push({
      url,
      headers: init.headers as Record<string, string> | undefined,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.endsWith('/session')) {
      return new Response(JSON.stringify({ id: 'ses_probe', title: 'tourbillon' }), { status: 200 });
    }
    return promptResponse();
  }) as unknown as typeof fetch;

  const result = await dispatchOpencodeHeartbeat(context(), {
    bind: localHttpBind,
    callbackBaseUrl: 'http://127.0.0.1:3002',
    timeoutSec: 30,
    deps: { fetchImpl: fakeFetch },
  });

  assert.equal(calls.length, 2, 'exactly the two measured OpenCode POSTs — no A2A path');
  assert.equal(calls[0].url, 'http://127.0.0.1:4096/session');
  assert.equal(calls[1].url, 'http://127.0.0.1:4096/session/ses_probe/message');
  // local loopback API without apiToken: no Authorization header
  assert.equal(calls[0].headers?.Authorization, undefined);
  assert.equal(calls[1].headers?.Authorization, undefined);

  // session create carries the machine-readable envelope
  const meta = calls[0].body?.metadata as { tourbillon: Record<string, unknown> };
  assert.equal(meta.tourbillon.kind, 'tourbillon.heartbeat');
  assert.equal(meta.tourbillon.runId, 'run-1');

  // prompt body: model derived from modelId; envelope JSON fenced in the text part
  assert.deepEqual(calls[1].body?.model, { providerID: 'lmstudio', modelID: 'qwen3.8-flash-next' });
  const parts = calls[1].body?.parts as Array<{ type: string; text: string }>;
  assert.equal(parts[0].type, 'text');
  assert.ok(parts[0].text.startsWith('WAKE PROMPT'));
  const fence = parts[0].text.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(fence);
  const envelope = JSON.parse(fence![1]);
  assert.equal(envelope.callback.baseUrl, 'http://127.0.0.1:3002');
  assert.equal(envelope.callback.sessionToken, SESSION_TOKEN);

  // measured response maps to a completed wake WITH reported usage
  assert.equal(result.finishReason, 'complete');
  assert.equal(result.transport, 'http');
  assert.equal(result.harnessRunId, 'ses_probe');
  assert.equal(result.inputTokens, 8229);
  assert.equal(result.outputTokens, 4);
});

test('remote bind: Bearer apiToken on both calls; target is harnessBaseUrl', async () => {
  const seen: string[] = [];
  const result = await dispatchOpencodeHeartbeat(context(), {
    bind: remoteBind,
    callbackBaseUrl: 'http://192.168.100.5:3002',
    timeoutSec: 30,
    deps: {
      fetchImpl: (async (u: unknown, init?: RequestInit) => {
        seen.push((init?.headers as Record<string, string>).Authorization);
        if (String(u).endsWith('/session')) {
          return new Response(JSON.stringify({ id: 'ses_remote' }), { status: 200 });
        }
        return promptResponse();
      }) as unknown as typeof fetch,
    },
  });
  assert.deepEqual(seen, [`Bearer ${REMOTE_TOKEN}`, `Bearer ${REMOTE_TOKEN}`]);
  assert.equal(result.finishReason, 'complete');
  assert.equal(opencodeHttpTargetOrigin(remoteBind), 'http://100.105.50.60:4096');
});

test('http bind: session-create non-2xx is an error (e.g. unsecured/proxy 401)', async () => {
  const result = await dispatchOpencodeHeartbeat(context(), {
    bind: remoteBind,
    callbackBaseUrl: 'http://192.168.100.5:3002',
    timeoutSec: 30,
    deps: { fetchImpl: (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch },
  });
  assert.equal(result.finishReason, 'error');
  assert.match(result.detail ?? '', /session create HTTP 401/);
});

test('http bind: prompt non-2xx is an error but keeps the session id for cleanup', async () => {
  const result = await dispatchOpencodeHeartbeat(context(), {
    bind: localHttpBind,
    callbackBaseUrl: 'http://127.0.0.1:3002',
    timeoutSec: 30,
    deps: {
      fetchImpl: (async (u: unknown) =>
        String(u).endsWith('/session')
          ? new Response(JSON.stringify({ id: 'ses_partial' }), { status: 200 })
          : new Response('busy', { status: 500 })) as unknown as typeof fetch,
    },
  });
  assert.equal(result.finishReason, 'error');
  assert.equal(result.harnessRunId, 'ses_partial');
  assert.match(result.detail ?? '', /prompt HTTP 500/);
});

test('http bind: non-"stop" finish is an error, never a silent pass', async () => {
  const result = await dispatchOpencodeHeartbeat(context(), {
    bind: localHttpBind,
    callbackBaseUrl: 'http://127.0.0.1:3002',
    timeoutSec: 30,
    deps: {
      fetchImpl: (async (u: unknown) =>
        String(u).endsWith('/session')
          ? new Response(JSON.stringify({ id: 'ses_probe' }), { status: 200 })
          : promptResponse({ info: { finish: 'error', tokens: {} } })) as unknown as typeof fetch,
    },
  });
  assert.equal(result.finishReason, 'error');
  assert.match(result.detail ?? '', /info\.finish error/);
});

test('http bind: wall-clock timeout surfaces as timeout', async () => {
  const result = await dispatchOpencodeHeartbeat(context(), {
    bind: localHttpBind,
    callbackBaseUrl: 'http://127.0.0.1:3002',
    timeoutSec: 0.05,
    deps: {
      fetchImpl: ((_u: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          (init?.signal as AbortSignal)?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        })) as unknown as typeof fetch,
    },
  });
  assert.equal(result.finishReason, 'timeout');
});

test('http bind: wake abort surfaces as timeout', async () => {
  const ac = new AbortController();
  const resultPromise = dispatchOpencodeHeartbeat(context(), {
    bind: localHttpBind,
    callbackBaseUrl: 'http://127.0.0.1:3002',
    timeoutSec: 30,
    abortSignal: ac.signal,
    deps: {
      fetchImpl: ((_u: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          (init?.signal as AbortSignal)?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        })) as unknown as typeof fetch,
    },
  });
  ac.abort();
  const result = await resultPromise;
  assert.equal(result.finishReason, 'timeout');
  assert.equal(result.detail, 'wake aborted');
});

test('custom skillInstall blob reaches the envelope (command + prompt text)', async () => {
  let wakeJson = '';
  await dispatchOpencodeHeartbeat(context(), {
    bind: { ...localCommandBind, skillInstall: 'CUSTOM' },
    callbackBaseUrl: 'http://127.0.0.1:3002',
    timeoutSec: 30,
    deps: {
      spawnCommand: async (_cmd, env) => {
        wakeJson = env.TOURBILLON_WAKE_JSON ?? '';
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });
  assert.equal(JSON.parse(wakeJson).skillInstall, 'CUSTOM');

  let promptText = '';
  await dispatchOpencodeHeartbeat(context(), {
    bind: { ...localHttpBind, skillInstall: 'CUSTOM' },
    callbackBaseUrl: 'http://127.0.0.1:3002',
    timeoutSec: 30,
    deps: {
      fetchImpl: (async (u: unknown, init?: RequestInit) => {
        if (String(u).endsWith('/session')) {
          return new Response(JSON.stringify({ id: 'ses_probe' }), { status: 200 });
        }
        promptText = String(JSON.parse(String(init?.body)).parts[0].text);
        return promptResponse();
      }) as unknown as typeof fetch,
    },
  });
  // skillInstall rides in the fenced envelope the skill tells OpenCode to expect
  assert.match(promptText, /"skillInstall": "CUSTOM"/);
});

test('no modelId → server default model (no model key on the prompt body)', async () => {
  let body: Record<string, unknown> | undefined;
  await dispatchOpencodeHeartbeat(context({ modelId: null }), {
    bind: localHttpBind,
    callbackBaseUrl: 'http://127.0.0.1:3002',
    timeoutSec: 30,
    deps: {
      fetchImpl: (async (u: unknown, init?: RequestInit) => {
        if (!String(u).endsWith('/session')) body = JSON.parse(String(init?.body));
        return String(u).endsWith('/session')
          ? new Response(JSON.stringify({ id: 'ses_probe' }), { status: 200 })
          : promptResponse();
      }) as unknown as typeof fetch,
    },
  });
  assert.ok(body);
  assert.equal('model' in body, false);
});

test('test-seam sanity: deps.envelope override bypasses the builder (tests only)', async () => {
  const deps: OpencodeDispatchDeps = { envelope: undefined };
  assert.equal(deps.envelope, undefined);
});
