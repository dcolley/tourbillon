/**
 * #281 Hermes adapter — behaviour pins:
 *  1. A heartbeat with no session token / no callback origin must FAIL before any transport
 *     is touched (deps would explode if called).
 *  2. Every dispatch — command or HTTP, local or remote — carries callback.baseUrl +
 *     callback.sessionToken (env, stdin, and A2A metadata respectively).
 *  3. Capability-boundary transport outcomes: non-2xx gateway, JSONRPC error, non-terminal
 *     A2A state, non-zero exit, wall-clock timeout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HermesHarnessConfigError } from '@tourbillon/shared/hermes-harness';
import {
  dispatchHermesHeartbeat,
  hermesHttpTargetOrigin,
  type HermesDispatchContext,
  type HermesDispatchDeps,
} from './adapters/hermes-adapter';

const REMOTE_TOKEN = 'tok-0123456789abcdef0';

function context(overrides: Partial<HermesDispatchContext> = {}): HermesDispatchContext {
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
    apiKey: 'pm_run_session_token',
    ...overrides,
  };
}

const localCommandBind = { harness: 'hermes' as const, mode: 'local' as const, command: 'hermes run' };
const localHttpBind = { harness: 'hermes' as const, mode: 'local' as const, localBaseUrl: 'http://127.0.0.1:9900' };
const remoteBind = {
  harness: 'hermes' as const,
  mode: 'remote' as const,
  harnessBaseUrl: 'http://100.105.50.60:9900',
  apiToken: REMOTE_TOKEN,
};

const neverCalled = (): never => {
  throw new Error('transport must NOT be touched when the heartbeat contract is incomplete');
};

test('PIN: missing session token fails closed — no transport touched', async () => {
  await assert.rejects(
    dispatchHermesHeartbeat(context({ apiKey: '' }), {
      bind: localCommandBind,
      callbackBaseUrl: 'http://127.0.0.1:3002',
      timeoutSec: 5,
      deps: { spawnCommand: neverCalled, fetchImpl: neverCalled as unknown as typeof fetch },
    }),
    HermesHarnessConfigError,
  );
});

test('PIN: missing callback origin fails closed — no transport touched', async () => {
  await assert.rejects(
    dispatchHermesHeartbeat(context(), {
      bind: localCommandBind,
      callbackBaseUrl: '   ',
      timeoutSec: 5,
      deps: { spawnCommand: neverCalled, fetchImpl: neverCalled as unknown as typeof fetch },
    }),
    HermesHarnessConfigError,
  );
});

test('command bind: envelope + callback reach the spawn env and stdin', async () => {
  let seenEnv: Record<string, string> | undefined;
  const result = await dispatchHermesHeartbeat(context(), {
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
  assert.equal(result.threadId, 'hermes-run-1');
  assert.equal(seenEnv?.TOURBILLON_CALLBACK_URL, 'http://127.0.0.1:3002');
  assert.equal(seenEnv?.TOURBILLON_SESSION_TOKEN, 'pm_run_session_token');
  const wake = JSON.parse(seenEnv?.TOURBILLON_WAKE_JSON ?? '{}');
  assert.equal(wake.kind, 'tourbillon.heartbeat');
  assert.equal(wake.callback.baseUrl, 'http://127.0.0.1:3002');
  assert.equal(wake.callback.sessionToken, 'pm_run_session_token');
  assert.equal(wake.prompt, 'WAKE PROMPT');
  assert.equal(wake.taskId, 'issue-1');
  assert.ok(wake.skillInstall.includes('tourbillon-agent'));
});

test('command bind: non-zero exit is a failed wake, not a silent success', async () => {
  const result = await dispatchHermesHeartbeat(context(), {
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
  const result = await dispatchHermesHeartbeat(context(), {
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

test('http bind (local loopback): A2A message/send carries callback contract in metadata', async () => {
  let url: string | undefined;
  let headers: Record<string, string> | undefined;
  let body: Record<string, unknown> | undefined;
  const fakeFetch = (async (u: unknown, init: RequestInit) => {
    url = String(u);
    headers = init.headers as Record<string, string>;
    body = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body?.id, result: { id: 'a2a-task-1', status: { state: 'completed' } } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof fetch;

  const result = await dispatchHermesHeartbeat(context(), {
    bind: localHttpBind,
    callbackBaseUrl: 'http://127.0.0.1:3002',
    timeoutSec: 30,
    deps: { fetchImpl: fakeFetch },
  });

  assert.equal(url, 'http://127.0.0.1:9900');
  assert.equal(result.finishReason, 'complete');
  assert.equal(result.harnessRunId, 'a2a-task-1');
  // local loopback API without apiToken: no Authorization header
  assert.equal(headers?.Authorization, undefined);
  assert.equal(body?.method, 'message/send');
  const message = (body as { params: { message: Record<string, unknown> } }).params.message;
  const envelope = (message.metadata as { tourbillon: Record<string, unknown> }).tourbillon;
  assert.equal((envelope.callback as { baseUrl: string }).baseUrl, 'http://127.0.0.1:3002');
  assert.equal((envelope.callback as { sessionToken: string }).sessionToken, 'pm_run_session_token');
  assert.equal((message.parts as Array<{ text: string }>)[0].text, 'WAKE PROMPT');
});

test('remote bind: Bearer apiToken sent; completed → complete', async () => {
  let headers: Record<string, string> | undefined;
  const result = await dispatchHermesHeartbeat(context(), {
    bind: remoteBind,
    callbackBaseUrl: 'http://192.168.100.5:3002',
    timeoutSec: 30,
    deps: {
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        headers = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({ jsonrpc: '2.0', result: { status: { state: 'completed' } } }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    },
  });
  assert.equal(headers?.Authorization, `Bearer ${REMOTE_TOKEN}`);
  assert.equal(result.finishReason, 'complete');
  assert.equal(hermesHttpTargetOrigin(remoteBind), 'http://100.105.50.60:9900');
});

test('http bind: non-2xx gateway is an error (e.g. unauthorized gateway)', async () => {
  const result = await dispatchHermesHeartbeat(context(), {
    bind: remoteBind,
    callbackBaseUrl: 'http://192.168.100.5:3002',
    timeoutSec: 30,
    deps: { fetchImpl: (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch },
  });
  assert.equal(result.finishReason, 'error');
  assert.match(result.detail ?? '', /HTTP 401/);
});

test('http bind: JSONRPC error object is an error', async () => {
  const result = await dispatchHermesHeartbeat(context(), {
    bind: remoteBind,
    callbackBaseUrl: 'http://192.168.100.5:3002',
    timeoutSec: 30,
    deps: {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32050, message: 'unauthorized' } }), {
          status: 200,
        })) as unknown as typeof fetch,
    },
  });
  assert.equal(result.finishReason, 'error');
  assert.match(result.detail ?? '', /-32050/);
});

test('http bind: non-terminal A2A state is an error, never a silent pass', async () => {
  const result = await dispatchHermesHeartbeat(context(), {
    bind: remoteBind,
    callbackBaseUrl: 'http://192.168.100.5:3002',
    timeoutSec: 30,
    deps: {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', result: { status: { state: 'working' } } }), {
          status: 200,
        })) as unknown as typeof fetch,
    },
  });
  assert.equal(result.finishReason, 'error');
  assert.match(result.detail ?? '', /working/);
});

test('http bind: wall-clock timeout surfaces as timeout', async () => {
  const result = await dispatchHermesHeartbeat(context(), {
    bind: remoteBind,
    callbackBaseUrl: 'http://192.168.100.5:3002',
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
  const resultPromise = dispatchHermesHeartbeat(context(), {
    bind: remoteBind,
    callbackBaseUrl: 'http://192.168.100.5:3002',
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

test('custom skillInstall blob reaches the envelope', async () => {
  let depsSeen: HermesDispatchDeps | undefined;
  let wakeJson = '';
  await dispatchHermesHeartbeat(context(), {
    bind: { ...localCommandBind, skillInstall: 'CUSTOM' },
    callbackBaseUrl: 'http://127.0.0.1:3002',
    timeoutSec: 30,
    deps: {
      spawnCommand: async (_cmd, env) => {
        depsSeen = { spawnCommand: undefined };
        wakeJson = env.TOURBILLON_WAKE_JSON ?? '';
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });
  assert.ok(depsSeen);
  assert.equal(JSON.parse(wakeJson).skillInstall, 'CUSTOM');
});
