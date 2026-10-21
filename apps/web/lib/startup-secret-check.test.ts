/**
 * Startup secret warning (lib/startup-secret-check.ts) and the instrumentation.ts register() hook.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRODUCTION_BUILD_PHASE,
  runStartupSecretCheck,
  shouldRunStartupSecretCheck,
} from './startup-secret-check';
import { register } from '../instrumentation';

const STRONG = 'Zx9pQ2mL7vR4tY8wB1nC6kH3jF5dS0aE'; // 32 chars
const SHORT = 'q7Wz3Kp9LmX2'; // 12 chars
const PLACEHOLDER = 'change-me-in-production';

function capture() {
  const lines: string[] = [];
  return { lines, log: (m: string) => lines.push(m) };
}

const runtime = { NEXT_RUNTIME: 'nodejs' };

describe('shouldRunStartupSecretCheck', () => {
  it('runs only in the Node.js runtime', () => {
    assert.equal(shouldRunStartupSecretCheck({ NEXT_RUNTIME: 'nodejs' }), true);
    assert.equal(shouldRunStartupSecretCheck({ NEXT_RUNTIME: 'edge' }), false);
    assert.equal(shouldRunStartupSecretCheck({}), false);
  });

  it('is skipped during next build', () => {
    assert.equal(
      shouldRunStartupSecretCheck({ NEXT_RUNTIME: 'nodejs', NEXT_PHASE: PRODUCTION_BUILD_PHASE }),
      false,
    );
    assert.equal(shouldRunStartupSecretCheck({ NEXT_PHASE: PRODUCTION_BUILD_PHASE }), false);
  });
});

describe('runStartupSecretCheck', () => {
  for (const [label, value, reason] of [
    ['unset', undefined, /is not set/],
    ['empty', '   ', /is not set/],
    ['too short', SHORT, /shorter than 32 characters/],
    ['placeholder', PLACEHOLDER, /placeholder/],
  ] as const) {
    it(`warns once when BETTER_AUTH_SECRET is ${label}, without the value`, () => {
      const { lines, log } = capture();
      const reported = runStartupSecretCheck({ ...runtime, BETTER_AUTH_SECRET: value }, log);
      assert.deepEqual(reported, ['BETTER_AUTH_SECRET']);
      assert.equal(lines.length, 1);
      assert.match(lines[0], /BETTER_AUTH_SECRET/);
      assert.match(lines[0], reason);
      if (value?.trim()) assert.ok(!lines[0].includes(value.trim()));
    });
  }

  it('stays silent for a strong value', () => {
    const { lines, log } = capture();
    assert.deepEqual(runStartupSecretCheck({ ...runtime, BETTER_AUTH_SECRET: STRONG }, log), []);
    assert.equal(lines.length, 0);
  });

  it('stays silent during next build even when the value is bad', () => {
    const { lines, log } = capture();
    const env = { ...runtime, NEXT_PHASE: PRODUCTION_BUILD_PHASE };
    assert.deepEqual(runStartupSecretCheck(env, log), []);
    assert.deepEqual(runStartupSecretCheck({ ...env, BETTER_AUTH_SECRET: SHORT }, log), []);
    assert.equal(lines.length, 0);
  });

  it('stays silent outside the Node.js runtime', () => {
    const { lines, log } = capture();
    assert.deepEqual(runStartupSecretCheck({ NEXT_RUNTIME: 'edge' }, log), []);
    assert.deepEqual(runStartupSecretCheck({}, log), []);
    assert.equal(lines.length, 0);
  });

  it('ignores the local-dev opt-in (it is per request)', () => {
    const { lines, log } = capture();
    runStartupSecretCheck(
      { ...runtime, NODE_ENV: 'development', TOURBILLON_BOARD_AUTH_INSECURE_DEV: '1' },
      log,
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0], /per request/);
  });

  it('never throws, even if logging fails', () => {
    assert.doesNotThrow(() =>
      runStartupSecretCheck(runtime, () => {
        throw new Error('log sink down');
      }),
    );
  });
});

describe('instrumentation register()', () => {
  const env = process.env as Record<string, string | undefined>;
  const KEYS = ['NEXT_RUNTIME', 'NEXT_PHASE', 'BETTER_AUTH_SECRET'];
  let saved: Record<string, string | undefined>;
  // Every console.error line register() writes. register() may run other startup checks too,
  // so assertions about this check only look at lines naming BETTER_AUTH_SECRET.
  let lines: string[];
  const authLines = () => lines.filter((l) => l.includes('BETTER_AUTH_SECRET'));
  let originalError: typeof console.error;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, env[k]]));
    for (const k of KEYS) delete env[k];
    lines = [];
    originalError = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
  });
  afterEach(() => {
    console.error = originalError;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete env[k];
      else env[k] = saved[k];
    }
  });

  it('logs one warning in the Node.js runtime when the secret is bad, without the value', async () => {
    env.NEXT_RUNTIME = 'nodejs';
    env.BETTER_AUTH_SECRET = SHORT;
    await register();
    assert.equal(authLines().length, 1);
    assert.ok(lines.every((l) => !l.includes(SHORT)), 'no output line contains the value');
  });

  it('is silent with a strong secret', async () => {
    env.NEXT_RUNTIME = 'nodejs';
    env.BETTER_AUTH_SECRET = STRONG;
    await register();
    assert.equal(authLines().length, 0);
  });

  it('is silent during next build and in the edge runtime', async () => {
    env.NEXT_RUNTIME = 'nodejs';
    env.NEXT_PHASE = PRODUCTION_BUILD_PHASE;
    await register();
    delete env.NEXT_PHASE;
    env.NEXT_RUNTIME = 'edge';
    await register();
    delete env.NEXT_RUNTIME;
    await register();
    assert.equal(authLines().length, 0);
  });
});
