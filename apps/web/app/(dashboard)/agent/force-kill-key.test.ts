/**
 * forceKillHeartbeatAction: SCHEDULER_API_KEY goes through the shared requireSchedulerApiKey
 * helper (unset, whitespace, placeholder, short) before any request is sent. Redirects name the
 * setting only; no value or length is echoed. All values are fakes.
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const VALID = 'force-kill-test-key-0123456789abcdefghij'; // 41 chars
const env = process.env as Record<string, string | undefined>;

describe('forceKillHeartbeatAction scheduler key', () => {
  let forceKillHeartbeatAction: typeof import('./actions').forceKillHeartbeatAction;
  let origFetch: typeof fetch;
  let calls: Array<{ url: string; auth: string | null }>;
  let savedKey: string | undefined;
  let savedWake: string | undefined;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: unknown, id: string) {
      if (id === 'next/headers') {
        return {
          cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
          headers: async () => new Headers(),
        };
      }
      if (id === 'next/cache') return { revalidatePath: () => {} };
      if (id === 'next/navigation') {
        return {
          redirect: (url: string) => {
            throw new Error(`redirect:${url}`);
          },
        };
      }
      if (id === '@tourbillon/db') {
        return { companies: {}, db: { query: { companies: { findFirst: async () => null } } } };
      }
      if (id === '@tourbillon/shared') {
        return {
          ensureCompanyWorkspace: async () => {},
          mergeCompanySettings: (a: unknown) => a,
          parseCompanySettings: (a: unknown) => a,
        };
      }
      if (id === 'drizzle-orm') return { eq: () => ({}), asc: (c: unknown) => c };
      if (id === '@/lib/agents') {
        return {
          AgentValidationError: class extends Error {},
          setAgentActive: async () => {},
          deleteAgent: async () => {},
          updateAgentRole: async () => {},
        };
      }
      if (id === '@/lib/heartbeat') {
        return { triggerAgentHeartbeat: async () => {}, retryFailedHeartbeat: async () => {} };
      }
      if (id === '@/lib/heartbeats') {
        return { getHeartbeatRun: async () => null, getInFlightHeartbeatRun: async () => null };
      }
      if (id === '@/lib/action-result') {
        return {
          actionError: (m: string) => ({ ok: false, error: m }),
          actionSuccess: (d: unknown) => ({ ok: true, data: d }),
        };
      }
      if (id === '@/lib/company') {
        return { requireBoardSession: async () => ({ userId: 'u1', companyId: 'c1' }) };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ forceKillHeartbeatAction } = await import('./actions'));
    Module.prototype.require = originalRequire;
  });

  beforeEach(() => {
    savedKey = env.SCHEDULER_API_KEY;
    savedWake = env.SCHEDULER_WAKE_URL;
    env.SCHEDULER_WAKE_URL = 'http://scheduler.test:3999';
    calls = [];
    origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), auth: headers.get('authorization') });
      return new Response(JSON.stringify({ killed: true }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (savedKey === undefined) delete env.SCHEDULER_API_KEY;
    else env.SCHEDULER_API_KEY = savedKey;
    if (savedWake === undefined) delete env.SCHEDULER_WAKE_URL;
    else env.SCHEDULER_WAKE_URL = savedWake;
  });

  function form(runId = 'run-1', companyId = 'company-1', returnPath = '/agent/a1') {
    const fd = new FormData();
    fd.set('runId', runId);
    fd.set('companyId', companyId);
    fd.set('returnPath', returnPath);
    return fd;
  }

  async function expectRedirect(key: string | undefined, pathFragment: string) {
    if (key === undefined) delete env.SCHEDULER_API_KEY;
    else env.SCHEDULER_API_KEY = key;
    await assert.rejects(
      () => forceKillHeartbeatAction(form()),
      (e: unknown) => e instanceof Error && e.message.startsWith(`redirect:${pathFragment}`),
    );
  }

  for (const [label, value] of [
    ['unset', undefined],
    ['short', 'short-secret-value-0042'],
    ['placeholder', 'change-me-in-production'],
    ['space-padded short value reaching 32', `Zq7Lw2${' '.repeat(26)}`],
    ['trailing newline', `${VALID}\n`],
    ['leading spaces', `   ${VALID}`],
  ] as const) {
    it(`redirects without sending a request when the key is ${label}`, async () => {
      await expectRedirect(value, '/agent/a1?error=SCHEDULER_API_KEY%20not%20configured');
      assert.equal(calls.length, 0);
    });
  }

  it('sends the configured bearer when the key is valid', async () => {
    env.SCHEDULER_API_KEY = VALID;
    await assert.rejects(
      () => forceKillHeartbeatAction(form()),
      (e: unknown) => e instanceof Error && e.message === 'redirect:/agent/a1?killed=1',
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].auth, `Bearer ${VALID}`);
    assert.match(calls[0].url, /\/internal\/force-kill\/run-1$/);
  });
});
