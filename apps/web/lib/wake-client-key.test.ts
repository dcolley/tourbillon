/**
 * wake-client: calls to the scheduler fail with a clear config error when SCHEDULER_API_KEY is
 * unset (or unusable) instead of sending an empty/undefined bearer header.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SchedulerKeyConfigError } from '@tourbillon/shared/scheduler-key';

const VALID = 'wake-client-test-key-0123456789abcdefghij';
const env = process.env as Record<string, string | undefined>;

describe('wake-client scheduler key', () => {
  let wakeClient: typeof import('./wake-client');
  let originalRequire: (id: string) => unknown;
  let origFetch: typeof fetch;
  let calls: Array<{ url: string; auth: string | null }>;
  let savedKey: string | undefined;

  before(async () => {
    const Module = require('module');
    originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: unknown, id: string) {
      if (id === './wake-payload') {
        return { enrichHeartbeatJob: async (d: unknown) => d };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    wakeClient = await import('./wake-client');
  });

  after(() => {
    require('module').prototype.require = originalRequire;
  });

  beforeEach(() => {
    savedKey = env.SCHEDULER_API_KEY;
    calls = [];
    origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), auth: headers.get('authorization') });
      return new Response(JSON.stringify({ scheduleId: 's1' }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (savedKey === undefined) delete env.SCHEDULER_API_KEY;
    else env.SCHEDULER_API_KEY = savedKey;
  });

  it('throws a clear error and sends nothing when the key is unset', async () => {
    delete env.SCHEDULER_API_KEY;
    await assert.rejects(
      () => wakeClient.requestAgentTimerScheduleSync('agent-1'),
      (e: unknown) =>
        e instanceof SchedulerKeyConfigError && /SCHEDULER_API_KEY is not set/.test((e as Error).message),
    );
    await assert.rejects(
      () => wakeClient.enqueueHeartbeat({ agentId: 'a', companyId: 'c', wakeReason: 'manual' } as never),
      SchedulerKeyConfigError,
    );
    assert.equal(calls.length, 0);
  });

  it('throws for a placeholder or short key without echoing it', async () => {
    for (const bad of ['change-me-in-production', 'short-secret-value-0123']) {
      env.SCHEDULER_API_KEY = bad;
      await assert.rejects(
        () => wakeClient.requestRoutineScheduleSync('routine-1'),
        (e: unknown) => e instanceof SchedulerKeyConfigError && !(e as Error).message.includes(bad),
      );
    }
    assert.equal(calls.length, 0);
  });

  it('sends the configured bearer key when valid', async () => {
    env.SCHEDULER_API_KEY = VALID;
    await wakeClient.requestAgentTimerScheduleSync('agent-1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].auth, `Bearer ${VALID}`);
    assert.match(calls[0].url, /\/internal\/schedules\/sync-agent$/);
  });
});
