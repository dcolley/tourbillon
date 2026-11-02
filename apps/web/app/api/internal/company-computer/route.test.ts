/**
 * Company Computer internal API (Slice 1) — auth + TWO-GATE + dry-run host pins.
 * Real route module; @tourbillon/db, run-token auth and the host adapter are mocked
 * with an in-memory store and the package's dry-run HostClient. No Docker, no HTTP.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import {
  GATE_AGENT_NO_COMPUTER,
  GATE_COMPANY_NOT_PROVISIONED,
  InMemorySessionStore,
  KASM_IMAGE,
  MAX_ACTIVE_SEATS,
  createDryRunHostClient,
  type HostClient,
} from '@tourbillon/company-computer';

let authPayload: { kind: 'run'; runId: string; agentId: string; companyId: string } | null = null;
let companyRow: { id: string; slug: string; hasComputer: boolean } | null = null;
let agentRow: { id: string; urlKey: string; hasComputer: boolean } | null = null;
let store: InMemorySessionStore;
let hostCalls: string[] = [];
let hostClient: HostClient = createDryRunHostClient({ env: {} });

type Route = { POST: (req: NextRequest, ctx: { params: Promise<{ action: string }> }) => Promise<Response> };
let route: Route;

const GATES_OPEN = () => {
  companyRow = { id: 'c1', slug: 'acme', hasComputer: true };
  agentRow = { id: 'a1', urlKey: 'ceo', hasComputer: true };
  authPayload = { kind: 'run', runId: 'r1', agentId: 'a1', companyId: 'c1' };
};

describe('POST /api/internal/company-computer/[action]', () => {
  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      const fromRoute = this.filename?.includes('/internal/company-computer/');
      if (id === '@/lib/auth/agent-token-auth' && fromRoute) {
        return {
          authenticateAgentToken: async (token: string) => (token === 'valid' ? authPayload : null),
          bearerToken: (v: string) => v?.replace(/^Bearer\s+/i, '') ?? null,
        };
      }
      if (id === '@/lib/company-computer-host' && fromRoute) {
        return {
          createDrizzleSessionStore: () => store,
          getCompanyComputerHostClient: () => hostClient,
        };
      }
      if (id === '@tourbillon/db' && fromRoute) {
        return {
          db: {
            query: {
              companies: { findFirst: async () => (companyRow ? { ...companyRow } : null) },
              agents: { findFirst: async () => (agentRow ? { ...agentRow } : null) },
            },
          },
          companies: {},
          agents: {},
        };
      }
      if (id === 'drizzle-orm' && fromRoute) return { eq: () => ({}) };
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    route = await import('./[action]/route');
  });

  beforeEach(() => {
    authPayload = null;
    companyRow = null;
    agentRow = null;
    store = new InMemorySessionStore();
    hostCalls = [];
    hostClient = {
      ...createDryRunHostClient({ env: {} }),
      ensureDirs: async () => { hostCalls.push('ensureDirs'); },
      startContainer: async (spec) => {
        hostCalls.push(`start:${spec.name}`);
        return { containerId: 'cid', startedAt: new Date() };
      },
      stopAndRemove: async (n) => { hostCalls.push(`stop:${n}`); },
      healthCheck: async () => true,
      execInContainer: async () => { hostCalls.push('exec'); return { stdout: '', stderr: '', exitCode: 0 }; },
      screenshot: async () => { hostCalls.push('shot'); return { imageBase64: 'AA', width: 8, height: 8 }; },
      sendInput: async () => { hostCalls.push('input'); return { success: true }; },
    };
  });

  const call = (action: string, opts: { token?: string | null; body?: unknown } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? 'valid'}`;
    return route.POST(
      new NextRequest(`http://localhost/api/internal/company-computer/${action}`, {
        method: 'POST',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }),
      { params: Promise.resolve({ action }) },
    );
  };

  const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

  // ---- auth ----
  it('401 without a Bearer token and for an invalid token', async () => {
    GATES_OPEN();
    assert.equal((await call('getSession', { token: null })).status, 401);
    assert.equal((await call('getSession', { token: 'forged' })).status, 401);
  });

  it('404 for an unknown action (gates open)', async () => {
    GATES_OPEN();
    const res = await call('launchMissiles');
    assert.equal(res.status, 404);
    assert.equal((await json(res)).error, 'unknown_action');
  });

  // ---- seat cap ----
  it('429 seat_cap_exceeded when MAX_ACTIVE_SEATS are live (and the cap is 4)', async () => {
    assert.equal(MAX_ACTIVE_SEATS, 4, 'Ops brief: ~4 TEST seats max');
    GATES_OPEN();
    const now = new Date();
    for (let i = 1; i <= MAX_ACTIVE_SEATS; i++) {
      store.seed({
        id: `ccs-${i}`, companyId: 'c1', agentId: `a-${i}`, agentUrlKey: `bot${i}`,
        containerName: `cc-acme-bot${i}`, image: KASM_IMAGE, vncPort: 6900 + i,
        status: 'running', createdAt: now, updatedAt: now, startedAt: now,
        destroyedAt: null, lastActivityAt: now, takeoverStatus: null, takeoverUserId: null,
      });
    }
    const res = await call('createSession');
    assert.equal(res.status, 429);
    assert.equal((await json(res)).error, 'seat_cap_exceeded');
    assert.deepEqual(hostCalls, [], 'no host work before the cap decision');
  });

  // ---- two gates ----
  it('403 company_not_provisioned when company hasComputer is false (locked wording)', async () => {
    GATES_OPEN();
    companyRow!.hasComputer = false;
    const res = await call('createSession');
    assert.equal(res.status, 403);
    const body = await json(res);
    assert.equal(body.error, 'company_not_provisioned');
    assert.equal(body.message, GATE_COMPANY_NOT_PROVISIONED);
    assert.deepEqual(hostCalls, [], 'no host side effects behind a closed gate');
  });

  it('403 agent_no_computer when agent hasComputer is false — toolset membership cannot bypass', async () => {
    GATES_OPEN();
    agentRow!.hasComputer = false;
    for (const action of ['createSession', 'getSession', 'destroySession', 'screenshot', 'click', 'typeText', 'openBrowser']) {
      const res = await call(action, { body: { x: 1, y: 1, text: 'hi', url: 'https://x.test' } });
      assert.equal(res.status, 403, action);
      const body = await json(res);
      assert.equal(body.error, 'agent_no_computer', action);
      assert.equal(body.message, GATE_AGENT_NO_COMPUTER, action);
    }
    assert.deepEqual(hostCalls, []);
  });

  // ---- dry-run host policy (zero seats until Ops contract) ----
  it('createSession answers 503 host_start_refused with the dry-run client; no phantom row', async () => {
    GATES_OPEN();
    hostClient = createDryRunHostClient({ env: {} });
    const res = await call('createSession');
    assert.equal(res.status, 503);
    assert.equal((await json(res)).error, 'host_start_refused');
    assert.equal(await store.findActiveByAgent('a1'), null);
  });

  it('with a live-capable mock host the full lifecycle works against the registry', async () => {
    GATES_OPEN();
    const create = await call('createSession');
    assert.equal(create.status, 200);
    const { session } = await json(create) as { session: { containerName: string; vncPort: number; status: string } };
    assert.equal(session.containerName, 'cc-acme-ceo');
    assert.equal(session.vncPort, 6901);
    assert.equal(session.status, 'running');
    assert.deepEqual(hostCalls, ['ensureDirs', 'start:cc-acme-ceo']);

    const shot = await call('screenshot');
    assert.equal(shot.status, 200);
    assert.equal((await json(shot)).imageBase64, 'AA');

    const click = await call('click', { body: { x: 5, y: 6, button: 'left' } });
    assert.equal(click.status, 200);

    const typed = await call('typeText', { body: { text: 'hello' } });
    assert.equal(typed.status, 200);

    const info = await call('getSessionInfo');
    assert.equal(info.status, 200);
    const live = await store.findActiveByAgent('a1');
    assert.equal(((await json(info)).session as { id: string }).id, live?.id);

    const destroy = await call('destroySession');
    assert.equal(destroy.status, 200);
    assert.equal((await json(destroy)).destroyed, true);
    assert.ok(hostCalls.includes('stop:cc-acme-ceo'));
    assert.equal(await store.findActiveByAgent('a1'), null);
  });

  it('getSession with no seat -> 200 { session: null }; destroy -> { destroyed: false }', async () => {
    GATES_OPEN();
    const info = await call('getSession');
    assert.equal(info.status, 200);
    assert.equal((await json(info)).session, null);
    const destroy = await call('destroySession');
    assert.equal(destroy.status, 200);
    assert.equal((await json(destroy)).destroyed, false);
  });

  // ---- input validation ----
  it('click rejects negative coords (400) and no-seat state (409)', async () => {
    GATES_OPEN();
    const bad = await call('click', { body: { x: -1, y: 0, button: 'left' } });
    assert.equal(bad.status, 400);
    const missing = await call('click', { body: { x: 1, y: 1, button: 'left' } });
    assert.equal(missing.status, 409);
    assert.equal((await json(missing)).error, 'no_session');
  });

  it('typeText rejects empty text; openBrowser rejects non-http(s) urls', async () => {
    GATES_OPEN();
    assert.equal((await call('typeText', { body: { text: '' } })).status, 400);
    const bad = await call('openBrowser', { body: { url: 'file:///etc/passwd' } });
    assert.equal(bad.status, 400);
  });

  // ---- Slice-2 stubs ----
  it('file manager / terminal / pressKey / mouseMove / scroll answer 501 not_implemented', async () => {
    GATES_OPEN();
    for (const action of ['openFileManager', 'openTerminal', 'pressKey', 'mouseMove', 'scroll']) {
      const res = await call(action, { body: {} });
      assert.equal(res.status, 501, action);
      assert.equal((await json(res)).error, 'not_implemented', action);
    }
  });

  // ---- S282-S2: the VNC password never crosses the HTTP surface (row or refusals) ----
  it('createSession 200: response body and stored rows carry no VNC password value', async () => {
    GATES_OPEN();
    const specs: Array<Record<string, string>> = [];
    hostClient = {
      ...createDryRunHostClient({ env: {} }),
      ensureDirs: async () => {},
      startContainer: async (spec) => {
        specs.push({ ...spec.env });
        return { containerId: 'cid', startedAt: new Date() };
      },
      stopAndRemove: async () => {},
      healthCheck: async () => true,
      execInContainer: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      screenshot: async () => ({ imageBase64: 'AA', width: 8, height: 8 }),
      sendInput: async () => ({ success: true }),
    };
    const res = await call('createSession');
    assert.equal(res.status, 200);
    assert.equal(specs.length, 1);
    const pw = specs[0].VNC_PW;
    assert.ok(pw && pw.length >= 16, 'the host spec carries the generated password (Slice 2 owns it)');
    assert.ok(!JSON.stringify(await json(res)).includes(pw), 'createSession response leaks the VNC password');
    for (const row of store.all()) {
      assert.ok(!JSON.stringify(row).includes(pw), 'stored row leaks the VNC password');
    }
    const info = await call('getSessionInfo');
    assert.ok(!JSON.stringify(await json(info)).includes(pw), 'getSessionInfo response leaks the VNC password');
  });

  it('createSession 503 (dry-run): refusal body carries no VNC password value', async () => {
    GATES_OPEN();
    const specs: Array<Record<string, string>> = [];
    const inner = createDryRunHostClient({ env: {} });
    hostClient = {
      ...inner,
      async startContainer(spec) {
        specs.push({ ...spec.env });
        return inner.startContainer(spec);
      },
    };
    const res = await call('createSession');
    assert.equal(res.status, 503);
    assert.equal(specs.length, 1);
    const pw = specs[0].VNC_PW;
    assert.ok(pw && pw.length >= 16);
    const bodyText = await res.text();
    assert.equal((JSON.parse(bodyText) as Record<string, unknown>).error, 'host_start_refused');
    assert.ok(!bodyText.includes(pw), 'refusal body leaks the VNC password');
  });
});
