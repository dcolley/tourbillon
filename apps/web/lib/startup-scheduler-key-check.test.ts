/**
 * Startup SCHEDULER_API_KEY warning (lib/startup-scheduler-key-check.ts) and the
 * instrumentation.ts register() hook.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEDULER_KEY_PRODUCTION_BUILD_PHASE,
  runStartupSchedulerKeyCheck,
  shouldRunStartupSchedulerKeyCheck,
} from './startup-scheduler-key-check';
import { register } from '../instrumentation';

const STRONG = 'Hk4tN8qW2zP6xR1vB9mJ3cL7fD5sG0aYe'; // 33 chars
const SHORT = 'r5Tq8Lw2Zn7K'; // 12 chars
const PLACEHOLDER = 'change-me-in-production';
const TEMPLATE = '<generate with: openssl rand -base64 32>';
const PADDED_SHORT = `Zq7Lw2${' '.repeat(26)}`; // 6 visible chars padded with spaces to 32
const TRAILING_NEWLINE = `${STRONG}\n`; // 34 chars
const LEADING_SPACES = `  ${STRONG}`; // 35 chars

/** The line must not carry the value's length (raw or trimmed); lengths here are never 32/64. */
function assertNoLength(line: string, value: string) {
  for (const n of new Set([value.length, value.trim().length])) {
    if (n === 32) continue; // 32 is the documented minimum and appears in the fixed text
    assert.ok(!new RegExp(`\\b${n}\\b`).test(line), `warning must not contain the length ${n}`);
  }
}

function capture() {
  const lines: string[] = [];
  return { lines, log: (m: string) => lines.push(m) };
}

const runtime = { NEXT_RUNTIME: 'nodejs' };

describe('shouldRunStartupSchedulerKeyCheck', () => {
  it('runs only in the Node.js runtime', () => {
    assert.equal(shouldRunStartupSchedulerKeyCheck({ NEXT_RUNTIME: 'nodejs' }), true);
    assert.equal(shouldRunStartupSchedulerKeyCheck({ NEXT_RUNTIME: 'edge' }), false);
    assert.equal(shouldRunStartupSchedulerKeyCheck({}), false);
  });

  it('is skipped during next build', () => {
    assert.equal(
      shouldRunStartupSchedulerKeyCheck({ NEXT_RUNTIME: 'nodejs', NEXT_PHASE: SCHEDULER_KEY_PRODUCTION_BUILD_PHASE }),
      false,
    );
  });
});

describe('runStartupSchedulerKeyCheck', () => {
  for (const [label, value, reason] of [
    ['unset', undefined, /SCHEDULER_API_KEY is not set/],
    ['empty', '   ', /SCHEDULER_API_KEY is not set/],
    ['too short', SHORT, /SCHEDULER_API_KEY is shorter than 32 characters/],
    ['a placeholder', PLACEHOLDER, /SCHEDULER_API_KEY is a placeholder value/],
    ['the .env.example template', TEMPLATE, /SCHEDULER_API_KEY is a placeholder value/],
    ['short but space-padded to 32', PADDED_SHORT, /SCHEDULER_API_KEY has leading or trailing whitespace/],
    ['strong with a trailing newline', TRAILING_NEWLINE, /SCHEDULER_API_KEY has leading or trailing whitespace/],
    ['strong with a trailing space', `${STRONG} `, /SCHEDULER_API_KEY has leading or trailing whitespace/],
    ['strong with leading spaces', LEADING_SPACES, /SCHEDULER_API_KEY has leading or trailing whitespace/],
  ] as const) {
    it(`warns once when SCHEDULER_API_KEY is ${label}, without the value or its length`, () => {
      const { lines, log } = capture();
      assert.equal(runStartupSchedulerKeyCheck({ ...runtime, SCHEDULER_API_KEY: value }, log), true);
      assert.equal(lines.length, 1);
      assert.match(lines[0], reason);
      assert.match(lines[0], /openssl rand -base64 32/);
      if (value?.trim() && value !== TEMPLATE) assert.ok(!lines[0].includes(value.trim()));
      if (value?.trim()) assertNoLength(lines[0], value);
    });
  }

  it('checks the raw value: whitespace padding never counts toward the length', () => {
    assert.equal(PADDED_SHORT.length, 32);
    const { lines, log } = capture();
    assert.equal(runStartupSchedulerKeyCheck({ ...runtime, SCHEDULER_API_KEY: PADDED_SHORT }, log), true);
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], /shorter than/);
  });

  it('stays silent for a strong key', () => {
    const { lines, log } = capture();
    assert.equal(runStartupSchedulerKeyCheck({ ...runtime, SCHEDULER_API_KEY: STRONG }, log), false);
    assert.equal(lines.length, 0);
  });

  it('stays silent during next build even when the key is bad', () => {
    const { lines, log } = capture();
    const env = { ...runtime, NEXT_PHASE: SCHEDULER_KEY_PRODUCTION_BUILD_PHASE };
    assert.equal(runStartupSchedulerKeyCheck(env, log), false);
    assert.equal(runStartupSchedulerKeyCheck({ ...env, SCHEDULER_API_KEY: SHORT }, log), false);
    assert.equal(lines.length, 0);
  });

  it('stays silent outside the Node.js runtime', () => {
    const { lines, log } = capture();
    assert.equal(runStartupSchedulerKeyCheck({ NEXT_RUNTIME: 'edge' }, log), false);
    assert.equal(runStartupSchedulerKeyCheck({ NEXT_RUNTIME: 'edge', SCHEDULER_API_KEY: SHORT }, log), false);
    assert.equal(runStartupSchedulerKeyCheck({}, log), false);
    assert.equal(lines.length, 0);
  });

  it('never throws, even if logging fails', () => {
    assert.doesNotThrow(() =>
      runStartupSchedulerKeyCheck(runtime, () => {
        throw new Error('log sink down');
      }),
    );
  });
});

describe('instrumentation register() scheduler-key warning', () => {
  const env = process.env as Record<string, string | undefined>;
  const KEYS = ['NEXT_RUNTIME', 'NEXT_PHASE', 'SCHEDULER_API_KEY'];
  let saved: Record<string, string | undefined>;
  let lines: string[];
  let originalError: typeof console.error;
  // Only this check's lines; other startup checks registered alongside it are not under test here.
  const schedulerLines = () => lines.filter((l) => l.includes('SCHEDULER_API_KEY'));

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

  it('logs one warning in the Node.js runtime when the key is unset', async () => {
    env.NEXT_RUNTIME = 'nodejs';
    await register();
    assert.equal(schedulerLines().length, 1);
    assert.match(schedulerLines()[0], /SCHEDULER_API_KEY is not set/);
  });

  it('logs one warning for a short key, without the value or its length', async () => {
    env.NEXT_RUNTIME = 'nodejs';
    env.SCHEDULER_API_KEY = SHORT;
    await register();
    assert.equal(schedulerLines().length, 1);
    assert.ok(lines.every((l) => !l.includes(SHORT)));
    assertNoLength(schedulerLines()[0], SHORT);
  });

  it('logs one whitespace warning for a key with a trailing newline, without the value or its length', async () => {
    env.NEXT_RUNTIME = 'nodejs';
    env.SCHEDULER_API_KEY = TRAILING_NEWLINE;
    await register();
    assert.equal(schedulerLines().length, 1);
    assert.match(schedulerLines()[0], /SCHEDULER_API_KEY has leading or trailing whitespace/);
    assert.ok(lines.every((l) => !l.includes(STRONG)));
    assertNoLength(schedulerLines()[0], TRAILING_NEWLINE);
  });

  it('is silent with a strong key', async () => {
    env.NEXT_RUNTIME = 'nodejs';
    env.SCHEDULER_API_KEY = STRONG;
    await register();
    assert.equal(schedulerLines().length, 0);
    assert.ok(lines.every((l) => !l.includes(STRONG)));
  });

  it('is silent during next build and in the edge runtime', async () => {
    env.NEXT_RUNTIME = 'nodejs';
    env.NEXT_PHASE = SCHEDULER_KEY_PRODUCTION_BUILD_PHASE;
    await register();
    delete env.NEXT_PHASE;
    env.NEXT_RUNTIME = 'edge';
    await register();
    delete env.NEXT_RUNTIME;
    await register();
    assert.equal(lines.length, 0);
  });
});
