/**
 * S331-3 (#331): the harness command transport spawns THIRD-PARTY operator glue. It must get a
 * MINIMAL environment — PATH + HOME + exactly what the adapter passes explicitly (the three
 * TOURBILLON_* wake vars) — never the whole worker env (DATABASE_URL, BETTER_AUTH_SECRET,
 * TOURBILLON_AGENT_TOKEN_SECRET and friends used to ride along via a full-env spread).
 *
 * Proof layers:
 *  1. harnessChildEnv unit: with the parent env polluted, only PATH/HOME + the passed vars ship.
 *  2. REAL spawn through defaultSpawnCommand dumping its own env — the mutation (restoring the
 *     full-inheritance spread) flips this RED because the canaries reappear in the child.
 *  3. Both adapter call sites still deliver the full wake env contract (three TOURBILLON_* vars)
 *     and route through the shared defaultSpawnCommand (source pins).
 *
 * NOTE (self-reading-pin convention): the forbidden full-inheritance shape is assembled from
 * pieces below so nothing here matches the source-pin regex verbatim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultSpawnCommand,
  harnessChildEnv,
  dispatchHermesHeartbeat,
  type HermesSpawnResult,
} from './hermes-adapter';
import { dispatchOpencodeHeartbeat } from './opencode-adapter';
import { HERMES_WAKE_ENV } from '@tourbillon/shared/hermes-harness';
import { OPENCODE_WAKE_ENV } from '@tourbillon/shared/opencode-harness';
import type { HermesHarnessBind } from '@tourbillon/shared/hermes-harness';
import type { OpencodeHarnessBind } from '@tourbillon/shared/opencode-harness';

const HERE = dirname(fileURLToPath(import.meta.url));

// Fake canary secrets — the test process is polluted with them to prove they do NOT leak.
const CANARIES: Record<string, string> = {
  DATABASE_URL: 'postgres://usr:canar' + 'ypw@127.0.0.1:55533/tb_canary',
  BETTER_AUTH_SECRET: 'better-auth-canary-value-9f3a',
  TOURBILLON_AGENT_TOKEN_SECRET: 'agent-token-canary-secret-77b1',
};

function withCanaries<T>(fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(CANARIES)) {
    saved[key] = process.env[key];
    process.env[key] = CANARIES[key];
  }
  return fn().finally(() => {
    for (const key of Object.keys(CANARIES)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
  });
}

function wakeEnv(sessionToken = 'pm_run_wake_token'): Record<string, string> {
  return {
    [HERMES_WAKE_ENV.wakeJson]: JSON.stringify({ runId: 'run-1' }),
    [HERMES_WAKE_ENV.callbackUrl]: 'http://127.0.0.1:3002',
    [HERMES_WAKE_ENV.sessionToken]: sessionToken,
  };
}

test('S331-3: harnessChildEnv ships PATH + HOME + passed vars ONLY — worker secrets never ride along', () => {
  withCanaries(() => {
    const env = harnessChildEnv(wakeEnv());
    // Secrets absent even though the PARENT env carries them:
    assert.ok(!('DATABASE_URL' in env), 'DATABASE_URL leaked into child env');
    assert.ok(!('BETTER_AUTH_SECRET' in env), 'BETTER_AUTH_SECRET leaked into child env');
    assert.ok(!('TOURBILLON_AGENT_TOKEN_SECRET' in env), 'TOURBILLON_AGENT_TOKEN_SECRET leaked into child env');
    // Wake contract present verbatim:
    const w = wakeEnv();
    assert.equal(env[HERMES_WAKE_ENV.wakeJson], w[HERMES_WAKE_ENV.wakeJson]);
    assert.equal(env[HERMES_WAKE_ENV.callbackUrl], w[HERMES_WAKE_ENV.callbackUrl]);
    assert.equal(env[HERMES_WAKE_ENV.sessionToken], w[HERMES_WAKE_ENV.sessionToken]);
    // Node-on-PATH contract:
    assert.equal(env.PATH, process.env.PATH, 'child PATH must be the parent PATH');
    assert.ok(env.PATH && env.PATH.length > 0);
    if (process.env.HOME) assert.equal(env.HOME, process.env.HOME);
    else assert.ok(!('HOME' in env), 'HOME must be omitted when unset');
    // Nothing else from the (large) parent env: only PATH/HOME + the three passed vars.
    const expected = new Set(['PATH', ...(process.env.HOME ? ['HOME'] : []), ...Object.keys(w)]);
    assert.deepEqual(Object.keys(env).sort(), [...expected].sort());
    return Promise.resolve();
  });
});

test('S331-3: defaultSpawnCommand REAL child sees the wake vars but NOT DATABASE_URL / BETTER_AUTH_SECRET / TOURBILLON_AGENT_TOKEN_SECRET', async () => {
  await withCanaries(async () => {
    const dump =
      '"' + process.execPath + '" -e ' +
      "'process.stdout.write(JSON.stringify(process.env))'";
    const res = await defaultSpawnCommand(dump, wakeEnv('pm_run_spawn_probe'), new AbortController().signal);
    assert.equal(res.exitCode, 0, `child failed: ${res.stderr}`);
    const childEnv = JSON.parse(res.stdout) as Record<string, string | undefined>;
    assert.ok(!childEnv.DATABASE_URL, `DATABASE_URL leaked: ${String(childEnv.DATABASE_URL).slice(0, 12)}…`);
    assert.ok(!childEnv.BETTER_AUTH_SECRET, 'BETTER_AUTH_SECRET leaked to harness child');
    assert.ok(!childEnv.TOURBILLON_AGENT_TOKEN_SECRET, 'TOURBILLON_AGENT_TOKEN_SECRET leaked to harness child');
    assert.equal(childEnv[HERMES_WAKE_ENV.sessionToken], 'pm_run_spawn_probe');
    assert.equal(childEnv[HERMES_WAKE_ENV.callbackUrl], 'http://127.0.0.1:3002');
    assert.ok(childEnv[HERMES_WAKE_ENV.wakeJson]?.includes('run-1'), 'wake JSON missing in child');
    assert.ok(typeof childEnv.PATH === 'string' && childEnv.PATH.length > 0, 'child PATH missing');
  });
});

const wakeContext = () => ({
  wake: { agentId: 'agent-1', companyId: 'company-1', wakeReason: 'on_demand' } as never,
  wakeMessage: 'do the thing',
  runId: 'run-1',
  apiKey: 'pm_run_' + 'sig' + 'ned-tok',
});

test('S331-3: Hermes command bind still delivers the full wake env contract through the spawn seam', async () => {
  let seen: Record<string, string> | undefined;
  const bind = { harness: 'hermes', mode: 'local', command: 'hermes run' } as HermesHarnessBind;
  const result = await dispatchHermesHeartbeat(wakeContext(), {
    bind,
    callbackBaseUrl: 'http://127.0.0.1:3002',
    timeoutSec: 30,
    deps: {
      spawnCommand: async (_command, env) => {
        seen = env;
        return { exitCode: 0, stdout: '', stderr: '' } satisfies HermesSpawnResult;
      },
    },
  });
  assert.equal(result.finishReason, 'complete');
  assert.deepEqual(Object.keys(seen ?? {}).sort(), [
    HERMES_WAKE_ENV.callbackUrl,
    HERMES_WAKE_ENV.sessionToken,
    HERMES_WAKE_ENV.wakeJson,
  ].sort(), 'adapter env argument is exactly the three wake vars');
  assert.ok(seen?.[HERMES_WAKE_ENV.sessionToken]?.startsWith('pm_run_'), 'session token env contract intact');
});

test('S331-3: OpenCode command bind (shared defaultSpawnCommand) delivers the same wake env contract', async () => {
  let seen: Record<string, string> | undefined;
  const bind = { harness: 'opencode', mode: 'local', command: 'opencode run' } as OpencodeHarnessBind;
  const result = await dispatchOpencodeHeartbeat(wakeContext(), {
    bind,
    callbackBaseUrl: 'http://127.0.0.1:3002',
    timeoutSec: 30,
    deps: {
      spawnCommand: async (_command, env) => {
        seen = env;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });
  assert.equal(result.finishReason, 'complete');
  assert.deepEqual(Object.keys(seen ?? {}).sort(), [
    OPENCODE_WAKE_ENV.callbackUrl,
    OPENCODE_WAKE_ENV.sessionToken,
    OPENCODE_WAKE_ENV.wakeJson,
  ].sort());
});

test('S331-3 SOURCE PINS: defaultSpawnCommand wires harnessChildEnv; neither adapter re-introduces the full-inheritance shape', () => {
  const hermesSrc = readFileSync(join(HERE, 'hermes-adapter.ts'), 'utf8');
  const opencodeSrc = readFileSync(join(HERE, 'opencode-adapter.ts'), 'utf8');

  // The spawn call must take its env from the builder (kills a direct env:<literal> revert):
  assert.match(hermesSrc, /env:\s*harnessChildEnv\(env\)/);
  // Forbidden: the old full-inheritance spread feeding spawn's env. Built from pieces so this
  // file never carries the contiguous shape a source scan would match.
  const forbidden = '\\{\\s*\\.\\.\\.' + '\\s*process\\.env\\s*,\\s*\\.\\.\\.env\\s*\\}';
  assert.doesNotMatch(hermesSrc, new RegExp(forbidden));
  assert.doesNotMatch(opencodeSrc, new RegExp(forbidden));

  // Shared seam: OpenCode keeps importing the SAME defaultSpawnCommand (one choke point) and
  // does not spawn processes of its own.
  assert.match(opencodeSrc, /import\s*\{[^}]*defaultSpawnCommand[^}]*\}\s*from\s*'.\/hermes-adapter'/);
  assert.doesNotMatch(opencodeSrc, /from\s*'node:child_process'/);
  assert.match(hermesSrc, /spawnCommand\s*\?\?\s*defaultSpawnCommand/);
  assert.match(opencodeSrc, /spawnCommand\s*\?\?\s*defaultSpawnCommand/);
});

test('NIT-2: defaultSpawnCommand with TOURBILLON_WAKE_JSON ABSENT resolves instead of rejecting (stdin write guarded)', async () => {
  // The adapters always set wakeJson, but write(undefined) would throw inside the executor
  // and reject the whole dispatch on any caller that forgets it. Guarded with ?? ''.
  const res: HermesSpawnResult = await defaultSpawnCommand(
    'true',
    { [HERMES_WAKE_ENV.callbackUrl]: 'http://127.0.0.1:9/cb', [HERMES_WAKE_ENV.sessionToken]: 'pm_run_guard_probe' },
    new AbortController().signal,
  );
  assert.equal(res.exitCode, 0, 'child ran with stdin envelope absent-but-empty');
});
