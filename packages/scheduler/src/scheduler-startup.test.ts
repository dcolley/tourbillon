/**
 * SCHEDULER_API_KEY wiring in the scheduler process:
 * - src/index.ts refuses to start (exit 1) before any other work, logging the reason only;
 * - startWakeServer() refuses before creating or binding a server;
 * - routine issue create (schedule-boot) sends the key from the shared helper and refuses a bad one.
 * All values are dummies. No DB / Redis needed for the assertions; Redis handles are closed in
 * after() so the runner exits. Prefer: `tsx --test --test-force-exit src/scheduler-startup.test.ts`.
 */
import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SchedulerKeyConfigError } from '@tourbillon/shared/scheduler-key';

const VALID = 'scheduler-startup-test-key-0123456789abcdefgh'; // 45 chars
const BAD_KEYS: Array<[string, string, string]> = [
  ['short', 'r5Tq8Lw2Zn7Kp3', 'too_short'],
  ['space-padded short value reaching 32', `Zq7Lw2${' '.repeat(26)}`, 'whitespace'],
  ['trailing newline', `${VALID}\n`, 'whitespace'],
  ['leading spaces', `   ${VALID}`, 'whitespace'],
];
const env = process.env as Record<string, string | undefined>;

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = env.SCHEDULER_API_KEY;
});
afterEach(() => {
  mock.restoreAll();
  if (savedKey === undefined) delete env.SCHEDULER_API_KEY;
  else env.SCHEDULER_API_KEY = savedKey;
});

after(async () => {
  // wake-server / schedule-boot pull in redis.ts + redis-pub.ts, which open ioredis clients at
  // import time. Close both so the test process can exit without a live Redis.
  const redis = await import('./redis');
  const pub = await import('./redis-pub');
  try {
    redis.connection.disconnect();
  } catch {
    /* ignore */
  }
  try {
    pub.redisPub.disconnect();
  } catch {
    /* ignore */
  }
});

/** Silence and capture console.error / console.log for the duration of fn. */
function captureConsole<T>(fn: () => T): { result?: T; error?: unknown; lines: string[] } {
  const lines: string[] = [];
  const push = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  mock.method(console, 'error', push);
  mock.method(console, 'log', push);
  mock.method(console, 'warn', push);
  try {
    return { result: fn(), lines };
  } catch (error) {
    return { error, lines };
  }
}

describe('startWakeServer startup refusal', () => {
  let startWakeServer: typeof import('./wake-server').startWakeServer;

  before(async () => {
    ({ startWakeServer } = await import('./wake-server'));
  });

  for (const [label, value, reason] of BAD_KEYS) {
    it(`throws and never creates or binds a server when the key is ${label}`, () => {
      const createServer = mock.method(http, 'createServer');
      const listen = mock.method(http.Server.prototype, 'listen');
      env.SCHEDULER_API_KEY = value;
      const { error, lines } = captureConsole(() => startWakeServer());
      assert.ok(error instanceof SchedulerKeyConfigError, 'expected SchedulerKeyConfigError');
      assert.equal((error as SchedulerKeyConfigError).reason, reason);
      assert.equal(createServer.mock.callCount(), 0);
      assert.equal(listen.mock.callCount(), 0);
      assert.equal(lines.length, 1);
      assert.match(lines[0], /\[trace:wake-server\] refusing to start: SCHEDULER_API_KEY/);
      assert.ok(!lines[0].includes(value.trim()), 'log must not contain the value');
    });
  }

  it('creates and binds the server with a valid key (control)', () => {
    const fakeServer = { listen: mock.fn(() => fakeServer) };
    const createServer = mock.method(http, 'createServer', () => fakeServer);
    env.SCHEDULER_API_KEY = VALID;
    const { error, result } = captureConsole(() => startWakeServer());
    assert.equal(error, undefined);
    assert.equal(result, fakeServer);
    assert.equal(createServer.mock.callCount(), 1);
    assert.equal(fakeServer.listen.mock.callCount(), 1);
  });
});

describe('scheduler entry point (src/index.ts) startup refusal', () => {
  const schedulerRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

  for (const [label, value, reason] of BAD_KEYS.slice(0, 3)) {
    it(`exits 1 before any other work when the key is ${label}`, () => {
      const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: schedulerRoot,
        // Scrubbed env: no DB, Redis or other settings; only the dummy key under test.
        env: { PATH: env.PATH, HOME: env.HOME, SCHEDULER_API_KEY: value },
        encoding: 'utf8',
        timeout: 90_000,
      });
      const out = `${run.stdout}\n${run.stderr}`;
      assert.equal(run.status, 1, out);
      // The entry point's own check fires first (scheduler logger), not the wake server's.
      assert.match(out, /\[trace:scheduler\] refusing to start: SCHEDULER_API_KEY/);
      assert.ok(out.includes(`"reason":"${reason}"`), out);
      assert.ok(!out.includes('[trace:wake-server]'), 'wake server must not be reached');
      assert.ok(!out.includes('wake server listening'));
      assert.ok(!out.includes('scheduler started'));
      assert.ok(!out.includes(value.trim()), 'output must not contain the value');
    });
  }
});

describe('routine issue create (schedule-boot) uses the shared key helper', () => {
  let fireRoutineIssue: typeof import('./schedule-boot').fireRoutineIssue;
  const meta = { companyId: 'company-1', agentId: 'agent-1', routineId: 'routine-1', taskTemplate: { title: 't' } };

  before(async () => {
    ({ fireRoutineIssue } = await import('./schedule-boot'));
  });

  for (const [label, value, reason] of BAD_KEYS) {
    it(`refuses and sends nothing when the key is ${label}`, async () => {
      const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 201 }));
      env.SCHEDULER_API_KEY = value;
      await assert.rejects(
        () => fireRoutineIssue(meta),
        (e: unknown) =>
          e instanceof SchedulerKeyConfigError && e.reason === reason && !e.message.includes(value.trim()),
      );
      assert.equal(fetchMock.mock.callCount(), 0);
    });
  }

  it('refuses and sends nothing when the key is unset', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 201 }));
    delete env.SCHEDULER_API_KEY;
    await assert.rejects(() => fireRoutineIssue(meta), SchedulerKeyConfigError);
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it('sends the configured key as the bearer when valid', async () => {
    const auth: Array<string | null> = [];
    mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      auth.push(new Headers(init?.headers).get('authorization'));
      return new Response('nope', { status: 500 });
    });
    env.SCHEDULER_API_KEY = VALID;
    // A failing response stops before the DB update, so no database is needed.
    await assert.rejects(() => fireRoutineIssue(meta), /Issue create failed \(500\)/);
    assert.deepEqual(auth, [`Bearer ${VALID}`]);
  });
});
