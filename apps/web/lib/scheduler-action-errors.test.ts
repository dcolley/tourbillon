/**
 * Scheduler call failures in the dashboard heartbeat actions (run heartbeat, retry, force-kill)
 * and the MCP control-plane tools never put the thrown error text into the ?error= redirect or
 * the JSON-RPC tool error. The detail is logged server-side with Authorization values redacted.
 *
 * The REAL actions, MCP route, lib/heartbeat-actions, lib/mcp-scheduler, lib/heartbeat and
 * lib/wake-client run; @tourbillon/db, drizzle-orm, next/* and unrelated libs are faked.
 * fetch() is the real one (an invalid configured key makes it throw an error that echoes the
 * header value) or a stub. Every key and token below is a fake.
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';

const JWT_SECRET = 'test-better-auth-secret-not-default';
process.env.BETTER_AUTH_SECRET = JWT_SECRET;
process.env.TOURBILLON_BOARD_SECRET = 'test-operator-secret-sched';
delete process.env.TOURBILLON_BOARD_AUTH_INSECURE_DEV;
process.env.SCHEDULER_WAKE_URL = 'http://127.0.0.1:9';

/** Fake key fragment that must never leave the server. */
const FAKE_SECRET = 'fakeSchedKey9f3e';
/** A configured key the runtime refuses as a header value (inner line break). */
const BAD_KEY = `${FAKE_SECRET}\nX-Injected: 1`;
const GOOD_KEY = `${FAKE_SECRET}OkLooking`;

const reqState: { cookies: Record<string, string>; headers: Record<string, string> } = { cookies: {}, headers: {} };
type Pred = (row: Record<string, unknown>) => boolean;
const agentRows: Array<Record<string, unknown>> = [
  { id: 'agent-1', companyId: 'company-a', urlKey: 'one', name: 'One', status: 'active', runtimeConfig: {} },
];
const failedRun = {
  id: 'run-failed',
  agentId: 'agent-1',
  companyId: 'company-a',
  status: 'failed',
  contextSnapshot: { wakeReason: 'on_demand' },
};
const col = (name: string) => ({ __col: name });
const table = (cols: string[]) => Object.fromEntries(cols.map((c) => [c, col(c)]));
const fakeDrizzle = new Proxy(
  {
    eq: (c: { __col: string }, v: unknown): Pred => (r) => r[c.__col] === v,
    and: (...ps: Pred[]): Pred => (r) => ps.every((p) => p(r)),
  } as Record<string, unknown>,
  { get: (t, k) => (k in t ? t[k as string] : () => () => true) },
);
const fakeDb = new Proxy(
  {
    agents: table(['id', 'companyId', 'urlKey', 'status']),
    companies: table(['id']),
    db: {
      query: {
        agents: { findFirst: async ({ where }: { where: Pred }) => agentRows.find(where) },
        companies: { findFirst: async () => ({ id: 'company-a', name: 'A', settings: {} }) },
      },
    },
  } as Record<string, unknown>,
  { get: (t, k) => (k in t ? t[k as string] : table([])) },
);
const asyncStub = () => new Proxy({}, { get: (_t, k) => (k === '__esModule' ? true : async () => null) });

let logs: string[] = [];
let issueMode: 'wake' | 'raw' = 'wake';
const realConsoleError = console.error;
const realFetch = globalThis.fetch;

function assertNoSecret(text: string, where: string) {
  for (const form of [text, decodeURIComponent(text)]) {
    assert.ok(!form.includes(FAKE_SECRET), `${where} must not contain the key: ${form}`);
    assert.ok(!/X-Injected/i.test(form), `${where} must not contain header text: ${form}`);
  }
}

async function redirectOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    const m = /^redirect:(.*)$/s.exec((err as Error).message);
    if (m) return m[1];
    throw err;
  }
  throw new Error('expected a redirect');
}

describe('scheduler action errors: fixed messages, redacted logs', () => {
  let actions: typeof import('../app/(dashboard)/agent/actions');
  let helpers: typeof import('./heartbeat-actions');
  let mcp: typeof import('./mcp-scheduler');
  let wake: typeof import('./wake-client');
  let errors: typeof import('./scheduler-errors');
  let mcpPOST: (req: NextRequest) => Promise<Response>;
  let createBoardSessionToken: typeof import('./board-auth').createBoardSessionToken;
  let companyJwt: string;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    const STUBBED = new Set([
      '@tourbillon/mastra',
      '@/lib/observability',
      '@/lib/jobs',
      '@/lib/goals',
      '@/lib/projects',
      '@/lib/issue-comments',
      './issue-comments',
      '@/lib/llm-providers',
      './llm-providers',
      './chat',
    ]);
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      if (id === '@tourbillon/db') return fakeDb;
      if (id === 'drizzle-orm') return fakeDrizzle;
      if (STUBBED.has(id)) return asyncStub();
      if (id === '@/lib/issues') {
        // Like the real createIssue: an assigned issue triggers an assignment wake on the scheduler.
        return {
          createIssue: async (input: { assigneeAgentId?: string; companyId: string }) => {
            if (issueMode === 'raw') throw new Error(`assignment wake failed: Authorization: Bearer ${FAKE_SECRET}`);
            await wake.enqueueHeartbeat({
              agentId: input.assigneeAgentId!,
              agentName: 'One',
              companyId: input.companyId,
              invocationSource: 'assignment',
              wakeReason: 'assignment',
            });
            throw new Error('unreachable in these tests');
          },
          updateIssue: async () => null,
          getIssueDetail: async () => null,
          listIssues: async () => ({ issues: [] }),
        };
      }
      if (id === '@/lib/heartbeats') {
        return {
          getHeartbeatRun: async (runId: string) => (runId === failedRun.id ? { run: failedRun, agent: null } : null),
          getInFlightHeartbeatRun: async () => null,
          getHeartbeatList: async () => [],
        };
      }
      if (id === 'next/headers') {
        return {
          cookies: async () => ({
            get: (n: string) => (n in reqState.cookies ? { name: n, value: reqState.cookies[n] } : undefined),
            set: () => {},
            delete: () => {},
          }),
          headers: async () => new Headers(reqState.headers),
        };
      }
      if (id === 'next/cache') return { revalidatePath: () => {} };
      if (id === 'next/navigation') {
        return { redirect: (url: string) => { throw new Error(`redirect:${url}`); } };
      }
      if (id === '@tourbillon/shared' && this.filename?.endsWith('/lib/company.ts')) {
        return { ensureCompanyWorkspace: async () => {}, mergeCompanySettings: (a: unknown) => a, parseCompanySettings: (a: unknown) => a };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    actions = await import('../app/(dashboard)/agent/actions');
    helpers = await import('./heartbeat-actions');
    mcp = await import('./mcp-scheduler');
    wake = await import('./wake-client');
    errors = await import('./scheduler-errors');
    ({ POST: mcpPOST } = (await import('../app/api/mcp/route')) as never);
    ({ createBoardSessionToken } = await import('./board-auth'));
    companyJwt = await new SignJWT({ companyId: 'company-a' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(JWT_SECRET));
  });

  beforeEach(async () => {
    logs = [];
    console.error = (...args: unknown[]) => {
      logs.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' '));
    };
    globalThis.fetch = realFetch;
    process.env.SCHEDULER_API_KEY = BAD_KEY;
    reqState.headers = {};
    reqState.cookies = { tourbillon_board_session: (await createBoardSessionToken())! };
  });

  afterEach(() => {
    console.error = realConsoleError;
    globalThis.fetch = realFetch;
  });

  function assertRedactedLog(context: RegExp) {
    const line = logs.find((l) => context.test(l));
    assert.ok(line, `expected a server-side log for ${context}; got ${JSON.stringify(logs)}`);
    for (const l of logs) assertNoSecret(l, 'server log');
    assert.match(line!, /\[redacted\]/);
  }

  const form = (entries: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(entries)) fd.set(k, v);
    return fd;
  };

  /** fetch stub: throws an error echoing a Bearer value the env split cannot see. */
  const throwingFetch = (async () => {
    throw new TypeError(`Headers.append: "Bearer ${FAKE_SECRET}-other\\nX-Injected: 1" is an invalid header value.`);
  }) as typeof fetch;

  /** fetch stub: scheduler answers 500 with a body that echoes the request header. */
  const echoingFetch = (async (_url: unknown, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>).Authorization;
    return new Response(JSON.stringify({ error: `bad header Authorization: ${auth}` }), { status: 500 });
  }) as typeof fetch;

  // --- the real fetch() echoes the configured key in its error ---------------------------------
  it('sanity: the runtime error for this configured key really contains the key', async () => {
    await assert.rejects(
      () => realFetch('http://127.0.0.1:9/x', { headers: { Authorization: `Bearer ${BAD_KEY}` } }),
      (err: Error) => err.message.includes(FAKE_SECRET),
    );
  });

  // --- dashboard actions ----------------------------------------------------------------------
  it('run heartbeat: redirect carries the fixed message, never the fetch error text', async () => {
    const url = await redirectOf(() =>
      actions.triggerAgentHeartbeatAction(form({ agentId: 'agent-1', companyId: 'company-a', urlKey: 'one' })),
    );
    assert.equal(url, `/agent/one?error=${encodeURIComponent(helpers.RUN_HEARTBEAT_ERROR_MESSAGE)}`);
    assertNoSecret(url, 'redirect');
    assertRedactedLog(/\[scheduler\] wake failed/);
  });

  it('force-kill: redirect carries the fixed message, never the fetch error text', async () => {
    const url = await redirectOf(() =>
      actions.forceKillHeartbeatAction(
        form({ runId: 'run-1', companyId: 'company-a', returnPath: '/heartbeat/run-1' }),
      ),
    );
    assert.equal(url, `/heartbeat/run-1?error=${encodeURIComponent(helpers.FORCE_KILL_ERROR_MESSAGE)}`);
    assertNoSecret(url, 'redirect');
    assertRedactedLog(/\[scheduler\] force-kill failed/);
  });

  it('retry heartbeat: redirect carries the fixed message, never the fetch error text', async () => {
    const url = await redirectOf(() =>
      actions.retryFailedHeartbeatAction(form({ runId: failedRun.id, companyId: 'company-a' })),
    );
    assert.equal(url, `/heartbeat/${failedRun.id}?error=${encodeURIComponent(helpers.RETRY_HEARTBEAT_ERROR_MESSAGE)}`);
    assertNoSecret(url, 'redirect');
    assertRedactedLog(/\[scheduler\] wake failed/);
  });

  it('run heartbeat + force-kill: a thrown Bearer value or an echoing 500 body never reaches the redirect', async () => {
    process.env.SCHEDULER_API_KEY = GOOD_KEY;
    for (const stub of [throwingFetch, echoingFetch]) {
      globalThis.fetch = stub;
      logs = [];
      const run = await redirectOf(() =>
        actions.triggerAgentHeartbeatAction(form({ agentId: 'agent-1', companyId: 'company-a', urlKey: 'one' })),
      );
      assert.equal(run, `/agent/one?error=${encodeURIComponent(helpers.RUN_HEARTBEAT_ERROR_MESSAGE)}`);
      const kill = await redirectOf(() =>
        actions.forceKillHeartbeatAction(form({ runId: 'run-1', companyId: 'company-a', returnPath: '/heartbeat/run-1' })),
      );
      assert.equal(kill, `/heartbeat/run-1?error=${encodeURIComponent(helpers.FORCE_KILL_ERROR_MESSAGE)}`);
      assertRedactedLog(/\[scheduler\] wake failed/);
      assertRedactedLog(/\[scheduler\] force-kill failed/);
    }
  });

  it('helpers: a raw error from the scheduler call (any source) never reaches the redirect', async () => {
    const raw = new Error(`fetch failed: Authorization: Bearer ${FAKE_SECRET}`);
    const run = await helpers.runHeartbeatRedirect('agent-1', 'company-a', '/agent', async () => {
      throw raw;
    });
    assert.equal(run, `/agent?error=${encodeURIComponent(helpers.RUN_HEARTBEAT_ERROR_MESSAGE)}`);
    const kill = await helpers.forceKillRedirect('run-1', 'company-a', '/heartbeat/run-1', async () => {
      throw raw;
    });
    assert.equal(kill, `/heartbeat/run-1?error=${encodeURIComponent(helpers.FORCE_KILL_ERROR_MESSAGE)}`);
    assertRedactedLog(/\[scheduler\] run heartbeat failed/);
    assertRedactedLog(/\[scheduler\] force-kill failed/);
  });

  it('force-kill: known refusals map to fixed messages; success still redirects with killed=1', async () => {
    process.env.SCHEDULER_API_KEY = GOOD_KEY;
    const cases: Array<[number, string]> = [
      [404, 'Heartbeat run not found or not running.'],
      [409, 'Heartbeat run already finished.'],
    ];
    for (const [status, message] of cases) {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: `upstream text ${FAKE_SECRET}` }), { status })) as typeof fetch;
      const url = await helpers.forceKillRedirect('run-1', 'company-a', '/heartbeat/run-1');
      assert.equal(url, `/heartbeat/run-1?error=${encodeURIComponent(message)}`);
    }
    let seen: { url: string; auth: string } | undefined;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      seen = { url: String(url), auth: (init?.headers as Record<string, string>).Authorization };
      return Response.json({ killed: true });
    }) as typeof fetch;
    assert.equal(await helpers.forceKillRedirect('run-1', 'company-a', '/heartbeat/run-1'), '/heartbeat/run-1?killed=1');
    assert.deepEqual(seen, { url: 'http://127.0.0.1:9/internal/force-kill/run-1', auth: `Bearer ${GOOD_KEY}` });
    delete process.env.SCHEDULER_API_KEY;
    assert.equal(
      await helpers.forceKillRedirect('run-1', 'company-a', '/heartbeat/run-1'),
      `/heartbeat/run-1?error=${encodeURIComponent('Scheduler is not configured.')}`,
    );
  });

  // --- wake-client: thrown errors are fixed text -----------------------------------------------
  it('wake-client: every scheduler call throws a fixed-message SchedulerRequestError', async () => {
    for (const key of [BAD_KEY, GOOD_KEY]) {
      process.env.SCHEDULER_API_KEY = key;
      for (const stub of key === BAD_KEY ? [realFetch] : [throwingFetch, echoingFetch]) {
        globalThis.fetch = stub;
        const calls: Array<() => Promise<unknown>> = [
          () => wake.enqueueHeartbeat({ agentId: 'agent-1', agentName: 'One', companyId: 'company-a', invocationSource: 'on_demand', wakeReason: 'on_demand' }),
          () => wake.requestAgentTimerScheduleSync('agent-1'),
          () => wake.requestRoutineScheduleSync('routine-1'),
          () => wake.requestForceKill('run-1', 'company-a'),
        ];
        for (const call of calls) {
          await assert.rejects(call, (err: Error) => {
            assert.ok(err instanceof errors.SchedulerRequestError, `got ${err}`);
            assert.equal(err.message, errors.SCHEDULER_REQUEST_ERROR_MESSAGE);
            assertNoSecret(`${err.message}\n${err.stack}`, 'thrown error');
            return true;
          });
        }
      }
    }
    for (const l of logs) assertNoSecret(l, 'server log');
  });

  // --- MCP ------------------------------------------------------------------------------------
  async function mcpCall(name: string, args: Record<string, unknown>) {
    const res = await mcpPOST(
      new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-company-token': companyJwt },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }),
    );
    const text = await res.text();
    return { text, body: JSON.parse(text) as { error?: { code: number; message: string }; result?: unknown } };
  }

  it('MCP wake_agent: the tool error is the fixed message, never the fetch error text', async () => {
    for (const [key, stub] of [[BAD_KEY, realFetch], [GOOD_KEY, throwingFetch], [GOOD_KEY, echoingFetch]] as const) {
      process.env.SCHEDULER_API_KEY = key;
      globalThis.fetch = stub;
      logs = [];
      const res = await mcpCall('wake_agent', { company_id: 'company-a', agent_id: 'agent-1' });
      assert.equal(res.body.error?.code, -32000);
      assert.equal(res.body.error?.message, mcp.MCP_SCHEDULER_ERROR_MESSAGE);
      assert.equal(res.body.result, undefined);
      assertNoSecret(res.text, 'MCP response');
      assertRedactedLog(/\[scheduler\] wake failed/);
    }
  });

  it('MCP create_issue (assignment wake): scheduler failure is the fixed message; raw tool errors are redacted', async () => {
    process.env.SCHEDULER_API_KEY = BAD_KEY;
    issueMode = 'wake';
    const args = { company_id: 'company-a', title: 'T', assignee_agent_id: 'agent-1' };
    const viaWake = await mcpCall('create_issue', args);
    assert.equal(viaWake.body.error?.message, mcp.MCP_SCHEDULER_ERROR_MESSAGE);
    assertNoSecret(viaWake.text, 'MCP response');
    assertRedactedLog(/\[scheduler\] wake failed/);
    issueMode = 'raw';
    const raw = await mcpCall('create_issue', args);
    issueMode = 'wake';
    assert.equal(raw.body.error?.code, -32000);
    assertNoSecret(raw.text, 'MCP response');
    assert.match(raw.body.error!.message, /\[redacted\]/);
  });

  it('MCP wake_agent: a raw error from the trigger never reaches the tool error', async () => {
    await assert.rejects(
      () => mcp.wakeAgentForMcp('agent-1', 'company-a', async () => {
        throw new Error(`Wake failed: Authorization: Bearer ${FAKE_SECRET}`);
      }),
      { message: mcp.MCP_SCHEDULER_ERROR_MESSAGE },
    );
    assertRedactedLog(/\[scheduler\] mcp wake_agent failed/);
  });

  it('MCP tools/call: other tool errors keep their message but lose Authorization values', () => {
    assert.equal(mcp.mcpToolErrorMessage(new Error('company_id is required')), 'company_id is required');
    const msg = mcp.mcpToolErrorMessage(new Error(`upstream said Authorization: Bearer ${FAKE_SECRET}`));
    assertNoSecret(msg, 'MCP tool error');
    assert.equal(mcp.mcpToolErrorMessage(new errors.SchedulerRequestError('bad_status', 500)), mcp.MCP_SCHEDULER_ERROR_MESSAGE);
  });

  // --- redaction ------------------------------------------------------------------------------
  it('redaction: configured key, Bearer/Basic credentials and Authorization pairs are removed', () => {
    process.env.SCHEDULER_API_KEY = BAD_KEY;
    const r = errors.redactSchedulerErrorDetail;
    const samples = [
      `Headers.append: "Bearer ${BAD_KEY}" is an invalid header value.`,
      `Headers.append: "Bearer ${JSON.stringify(BAD_KEY).slice(1, -1)}" is an invalid header value.`,
      `"Bearer ${FAKE_SECRET}-x\nX-Injected: 1"`,
      `Bearer ${FAKE_SECRET}`,
      `Basic ${FAKE_SECRET}==`,
      `Authorization: ${FAKE_SECRET}-x`,
      `{"authorization":"Token ${FAKE_SECRET}"}`,
      `raw key ${BAD_KEY} in text`,
    ];
    for (const s of samples) {
      const out = r(s);
      assertNoSecret(out, `redacted "${s}"`);
      assert.match(out, /\[redacted\]/);
    }
    assert.equal(r('Wake trigger failed (502): bad gateway'), 'Wake trigger failed (502): bad gateway');
  });
});
