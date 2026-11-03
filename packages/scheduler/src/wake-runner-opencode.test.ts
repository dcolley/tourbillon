/**
 * #281 second pack: wake-runner routing between the in-product harness, the Hermes bind and
 * the EXTERNAL OpenCode bind. Pins:
 *  1. adapterConfig.harness='opencode' + valid local bind → dispatchOpencodeHeartbeat receives
 *     the minted session token (signed pm_run_) and a LOOPBACK callbackBaseUrl derived from
 *     INTERNAL_API_URL, plus the agent modelId; runWithHarness and Hermes dispatch are never
 *     entered; the run row's contextSnapshot records harness.kind='opencode' + callbackBaseUrl.
 *  2. Malformed OpenCode bind → run fails loudly ('Invalid OpenCode harness bind'), NEITHER
 *     runtime is entered — no silent fallback to AgentController OR the Hermes dispatcher.
 *  3. Plain harness_local (no harness key) → unchanged in-product path; OpenCode dispatch never
 *     entered.
 *  4. A Hermes-bound agent never touches the OpenCode dispatcher (cross-discriminator isolation).
 *  5. S322-S2 (Refs #322): an external harness run NEVER calls the Mastra span scan
 *     detectTruncatedGeneration — the `if (!hermesBind && !opencodeBind)` guard at the
 *     harness branch of wake-runner.ts. Pinned fail-loud: the ./@tourbillon/db stub
 *     COUNTS every detectTruncatedGeneration invocation and throws, so removing the
 *     guard (or scanning unconditionally) turns every external-bind test RED instead
 *     of silently riding the benign `{ truncated: false }` stub.
 * @tourbillon/db, drizzle-orm, ./redis-pub, ./park-helpers and all adapters are mocked via
 * Module.prototype.require (wake-runner.ts only), mirroring wake-runner-hermes.test.ts.
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAgentTokenSignature } from '@tourbillon/shared/agent-token';
import { createRequire } from 'node:module';

const SECRET = 'test-agent-token-secret-281-oc-0123456789abcdef';
const env = process.env as Record<string, string | undefined>;
const dbRequire = createRequire(import.meta.url);
const DB_ENTRY = dbRequire.resolve('@tourbillon/db');
// ---- S322-S2: host-independent fail-loud wall on the span-scan seam ----
// wake-runner reaches detectTruncatedGeneration via `await import('@tourbillon/db')`
// from its ESM form. tsx resolves that through the ESM chain, BYPASSING both the
// Module.prototype.require hook (measured: no hook hit for the dynamic form) and the
// CJS require.cache seed — and the @tourbillon/mastra import inside wake-runner
// pulls the REAL '@tourbillon/db' into the ESM graph too. So the wall is the module
// itself, poisoned AT TOP LEVEL, before any import executes: assertValidDatabaseUrl
// rejects '' (fixed message, no credentials echoed — packages/db/src/database-url.ts)
// so EVERY later load of '@tourbillon/db' fails, on any host. A scan attempt on an
// external-bind run can therefore NEVER silently succeed: it either hits the
// fail-loud stub (CJS route) or the poisoned module rejection (ESM route). The
// exports captured here are the real namespace (client.ts only builds a lazy pool;
// no test in this file queries the real db).
const savedDatabaseUrl = env.DATABASE_URL;
// Capture the REAL namespace first (populates the CJS require cache under valid
// env — client.ts only builds a lazy pool), THEN poison: later ESM loads of the
// package re-evaluate under '' and reject, while cached CJS consumers keep real
// exports for the Proxy fallback.
const realDb = dbRequire('@tourbillon/db') as Record<string, unknown>;
const realEntry = dbRequire.cache[DB_ENTRY];
env.DATABASE_URL = '';

type Row = Record<string, unknown>;
type Cond = { op: 'eq'; c: string; val: unknown } | { op: 'and'; xs: Cond[] } | { op: 'other' };
const match = (r: Row, c?: Cond): boolean =>
  !c || c.op === 'other' ? true : c.op === 'eq' ? r[c.c] === c.val : c.xs.every((x) => match(r, x));
const table = (name: string) =>
  new Proxy({}, { get: (_t, prop: string) => (prop === '__table' ? name : { c: prop, t: name }) });

const store: Record<string, Row[]> = {};
let harnessCalls = 0;
let hermesCalls = 0;
let opencodeCalls: { context: Record<string, unknown>; options: Record<string, unknown> }[] = [];
/**
 * S322-S2: every detectTruncatedGeneration call the wake-runner makes through the
 * ./@tourbillon/db stub. Must stay 0 for external harness runs — the stub THROWS
 * (fail-loud), so a call both counts here and fails the wake with this marker in
 * errorText. A benign `{ truncated: false }` stub would let the span-scan-skip
 * guard (`!hermesBind && !opencodeBind`) be deleted with the suite still GREEN.
 */
let spanScanCalls = 0;
const SPAN_SCAN_CALLED = 'detectTruncatedGeneration must never be called for an external harness run (S322-S2 span-scan-skip pin)';

describe('#281 wake-runner OpenCode routing', () => {
  let triggerWake: typeof import('./wake-runner').triggerWake;

  before(async () => {
    env.TOURBILLON_AGENT_TOKEN_SECRET = SECRET;
    env.INTERNAL_API_URL = 'http://localhost:3002';
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    const tables = {
      agents: table('agents'),
      companies: table('companies'),
      heartbeatRuns: table('heartbeatRuns'),
      issues: table('issues'),
      costEvents: table('costEvents'),
      activityLog: table('activityLog'),
      approvals: table('approvals'),
    };
    const fakeDb = {
      query: new Proxy({}, {
        get: (_t, name: string) => ({
          findFirst: async ({ where }: { where?: Cond } = {}) => (store[name] ?? []).find((r) => match(r, where)),
        }),
      }),
      insert: (t: { __table: string }) => ({
        values: async (row: Row) => {
          (store[t.__table] ??= []).push({ ...row });
        },
      }),
      update: (t: { __table: string }) => ({
        set: (patch: Row) => ({
          where: async (where: Cond) => {
            for (const r of store[t.__table] ?? []) {
              if (!match(r, where)) continue;
              // The budget-snapshot update arrives as an sql concat the fake cannot evaluate;
              // keep the insert-time contextSnapshot intact for assertions.
              const { contextSnapshot: _skip, ...rest } = patch;
              void _skip;
              Object.assign(r, rest);
            }
          },
        }),
      }),
    };
    const stubKeys = new Set(['detectTruncatedGeneration', 'releaseStaleCheckoutLocksForRun']);
    // (S322-S2 walls live at top level: poisoned DATABASE_URL + realDb capture.
    // The Proxy below keeps REAL exports for any graph member that requires
    // '@tourbillon/db' fresh via CJS; only the scan keys are stubbed.)
    const dbStub = new Proxy(
      {
        db: fakeDb,
        ...tables,
        getLlmProviderRowById: async () => null,
        // S322-S2 fail-loud stub: external harness runs must never reach the Mastra
        // span scan (wake-runner.ts `if (!hermesBind && !opencodeBind)`). A call
        // counts AND throws so the wake fails -> the test's status/succeeded pins RED.
        detectTruncatedGeneration: async () => {
          spanScanCalls += 1;
          throw new Error(SPAN_SCAN_CALLED);
        },
        releaseStaleCheckoutLocksForRun: async () => 0,
      } as Record<string, unknown>,
      {
        // LAZY real-module delegation: mastra tools and other graph members require
        // '@tourbillon/db' too and must keep the REAL exports. Only the scan keys are
        // stubbed; everything else falls through to the real namespace on first touch.
        get(target, prop: string) {
          if (prop in target || stubKeys.has(prop)) return target[prop];
          return realDb[prop];
        },
        has(target, prop: string) {
          return prop in target || stubKeys.has(prop) || prop in realDb;
        },
      },
    );
    // S322-S2: wake-runner reaches the scan via `await import('@tourbillon/db')`,
    // which tsx compiles to a require call that BYPASSES the Module.prototype.require
    // hook below (it only ever sees the static requires — measured: no hook hit for
    // the dynamic form). Seed the same stub into require.cache keyed by the resolved
    // package entry so the dynamic seam lands on the stub too (shared CJS/ESM cache;
    // same recipe as scheduler-main.test.ts stubbing ./redis). The self-probe test
    // at the bottom of this describe fails LOUDLY if this seam ever stops holding.
    const dbSeed = {
      id: DB_ENTRY,
      filename: DB_ENTRY,
      loaded: true,
      exports: dbStub,
      children: [],
      paths: [],
    } as unknown as NodeJS.Require['cache'][string];
    // NOTE: plain assignment, NOT `??=` — the top-level realDb capture
    // already filled this cache slot with the REAL namespace; `??=` would
    // silently skip the seed and both walls would be dead (measured).
    dbRequire.cache[DB_ENTRY] = dbSeed;
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      if (!this?.filename?.endsWith('wake-runner.ts')) {
        return originalRequire.apply(this, arguments as unknown as [string]);
      }
      if (id === '@tourbillon/db') {
        return dbStub;
      }
      if (id === 'drizzle-orm') {
        return {
          eq: (col: { c: string }, val: unknown) => ({ op: 'eq', c: col.c, val }),
          and: (...xs: Cond[]) => ({ op: 'and', xs }),
          sql: () => ({ op: 'other' }),
          lt: () => ({ op: 'other' }),
        };
      }
      if (id === './redis-pub' || id.endsWith('/redis-pub')) {
        return { redisPub: { publish: async () => 1 } };
      }
      if (id === './park-helpers' || id.endsWith('/park-helpers')) {
        return {
          findIssueToPark: async () => null,
          hasMaterialWork: async () => false,
          shouldParkIssue: () => false,
        };
      }
      if (id === './adapters/harness-adapter' || id.endsWith('/adapters/harness-adapter')) {
        return {
          runWithHarness: async () => {
            harnessCalls += 1;
            // 'error' keeps the in-product assertion off the real-DB span scan (that path is
            // covered by the existing wake-runner suites); routing is what this file pins.
            return { threadId: 'in-product', inputTokens: 0, outputTokens: 0, finishReason: 'error' };
          },
        };
      }
      if (id === './adapters/hermes-adapter' || id.endsWith('/adapters/hermes-adapter')) {
        return {
          dispatchHermesHeartbeat: async () => {
            hermesCalls += 1;
            return { threadId: 'hermes-run', transport: 'command', inputTokens: 0, outputTokens: 0, finishReason: 'complete' };
          },
        };
      }
      if (id === './adapters/opencode-adapter' || id.endsWith('/adapters/opencode-adapter')) {
        return {
          dispatchOpencodeHeartbeat: async (context: Record<string, unknown>, options: Record<string, unknown>) => {
            opencodeCalls.push({ context, options });
            return { threadId: 'opencode-run', transport: 'http', inputTokens: 10, outputTokens: 2, finishReason: 'complete' };
          },
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ triggerWake } = await import('./wake-runner'));
  });

  const baseAgent = (adapterConfig: Record<string, unknown>): Row => ({
    id: 'agent-o',
    companyId: 'company-o',
    name: 'OpenCode Bound',
    urlKey: 'opencode-bound',
    status: 'active',
    adapterType: 'harness_local',
    adapterConfig,
    modelId: 'lmstudio/qwen3.8-flash-next',
    providerId: null,
    runtimeConfig: { timeout: { heartbeatSec: 300 } },
    budgetMonthlyTokens: 1_000_000,
    spentMonthlyTokens: 0,
  });

  beforeEach(() => {
    harnessCalls = 0;
    hermesCalls = 0;
    opencodeCalls = [];
    spanScanCalls = 0;
    store.agents = [];
    store.companies = [{ id: 'company-o', status: 'active' }];
    store.heartbeatRuns = [];
  });

  it('valid OpenCode local bind → dispatched with session token + loopback callbackUrl + modelId; in-product + Hermes skipped', async () => {
    store.agents = [baseAgent({ harness: 'opencode', mode: 'local', localBaseUrl: 'http://127.0.0.1:4096' })];
    const result = await triggerWake({
      agentId: 'agent-o',
      companyId: 'company-o',
      invocationSource: 'on_demand',
      wakeReason: 'on_demand',
    } as never);

    assert.equal(result.status, 'succeeded', String(result.errorText));
    assert.equal(harnessCalls, 0, 'in-product AgentController must not run for an OpenCode bind');
    assert.equal(hermesCalls, 0, 'an OpenCode bind must never reach the Hermes dispatcher');
    assert.equal(opencodeCalls.length, 1);
    // S322-S2: the completed OpenCode run must not pay for the Mastra span scan —
    // an external dispatch writes no Mastra spans. The stub throws on ANY call, so
    // deleting the `if (!hermesBind && !opencodeBind)` skip REDs this test.
    assert.equal(spanScanCalls, 0, 'external OpenCode run must never call detectTruncatedGeneration');

    const { context, options } = opencodeCalls[0];
    // EVERY heartbeat carries the minted run token + loopback callback origin.
    const claims = verifyAgentTokenSignature(context.apiKey as string);
    assert.ok(claims && claims.kind === 'run', 'session token must be a signed pm_run_ token');
    assert.equal(claims.runId, result.runId);
    assert.equal(claims.agentId, 'agent-o');
    assert.equal(options.callbackBaseUrl, 'http://127.0.0.1:3002', 'localhost INTERNAL_API_URL normalises to loopback');
    assert.equal((options.bind as { mode: string }).mode, 'local');
    assert.equal(context.modelId, 'lmstudio/qwen3.8-flash-next');
    assert.ok(typeof context.wakeMessage === 'string' && (context.wakeMessage as string).length > 0);

    const run = store.heartbeatRuns.find((r) => r.id === result.runId);
    assert.ok(run);
    assert.equal(run.status, 'succeeded');
    const snapshot = run.contextSnapshot as { harness?: { kind: string; callbackBaseUrl: string } };
    assert.equal(snapshot.harness?.kind, 'opencode');
    assert.equal(snapshot.harness?.callbackBaseUrl, 'http://127.0.0.1:3002');
  });

  it('malformed OpenCode bind → run fails loudly; NEITHER AgentController NOR Hermes is entered', async () => {
    store.agents = [baseAgent({ harness: 'opencode', mode: 'local' })]; // no command/localBaseUrl
    const result = await triggerWake({
      agentId: 'agent-o',
      companyId: 'company-o',
      invocationSource: 'on_demand',
      wakeReason: 'on_demand',
    } as never);

    assert.equal(result.status, 'failed');
    assert.match(result.errorText ?? '', /Invalid OpenCode harness bind/);
    assert.equal(harnessCalls, 0, 'a broken OpenCode bind must not silently fall back to the in-product harness');
    assert.equal(hermesCalls, 0, 'a broken OpenCode bind must not leak into the Hermes dispatcher');
    assert.equal(opencodeCalls.length, 0);
    const run = store.heartbeatRuns.find((r) => r.id === result.runId);
    assert.equal(run?.status, 'failed');
    assert.match(String(run?.errorText), /Invalid OpenCode harness bind/);
  });

  it('plain harness_local (no harness key) → in-product harness path unchanged', async () => {
    store.agents = [baseAgent({ provider: 'lmstudio' })];
    const result = await triggerWake({
      agentId: 'agent-o',
      companyId: 'company-o',
      invocationSource: 'on_demand',
      wakeReason: 'on_demand',
    } as never);

    // The in-product stub returns finishReason 'error' (see interceptor) — routing is the pin:
    // it went to runWithHarness, not the OpenCode dispatcher.
    assert.equal(result.status, 'failed');
    assert.match(result.errorText ?? '', /Harness run failed/);
    assert.equal(harnessCalls, 1);
    assert.equal(opencodeCalls.length, 0, 'non-OpenCode harness agents never touch the OpenCode dispatcher');
    assert.equal(hermesCalls, 0);
    const run = store.heartbeatRuns.find((r) => r.id === result.runId);
    const snapshot = run?.contextSnapshot as { harness?: unknown };
    assert.equal(snapshot.harness, undefined, 'no harness stamp on in-product runs');
  });

  it('Hermes-bound agent never touches the OpenCode dispatcher (cross-discriminator isolation)', async () => {
    store.agents = [baseAgent({ harness: 'hermes', mode: 'local', command: 'hermes run' })];
    const result = await triggerWake({
      agentId: 'agent-o',
      companyId: 'company-o',
      invocationSource: 'on_demand',
      wakeReason: 'on_demand',
    } as never);

    assert.equal(result.status, 'succeeded', String(result.errorText));
    assert.equal(hermesCalls, 1);
    assert.equal(opencodeCalls.length, 0);
    assert.equal(harnessCalls, 0);
    // S322-S2 (same seam, Hermes discriminator): the completed Hermes run must not
    // call the Mastra span scan either — the stub throws on any call.
    assert.equal(spanScanCalls, 0, 'external Hermes run must never call detectTruncatedGeneration');
  });

  // S322-S2 seam probe (dual-wall honesty guard): replay the EXACT dynamic import
  // wake-runner uses. The call MUST fail — either on the require.cache stub (CJS
  // route, if tsx ever merges the loaders) or on the poisoned DATABASE_URL (ESM
  // route, the load-bearing wall today). A probe that SUCCEEDS means both walls
  // fell and the spanScanCalls==0 pins above went silently vacuous -> RED here.
  it('S322-S2 seam: the dynamic import of @tourbillon/db cannot serve a real span scan', async () => {
    const before = spanScanCalls;
    let wall: 'stub' | 'url-poison' | 'MISSING' = 'MISSING';
    try {
      // The import itself sits INSIDE the try: the poisoned-DATABASE_URL wall
      // rejects the module load, so `import()` failing is a HIT on the wall,
      // not a test failure.
      const { detectTruncatedGeneration } = await import('@tourbillon/db');
      await detectTruncatedGeneration('seam-probe-run');
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.message === SPAN_SCAN_CALLED) wall = 'stub';
      else if (e.code === 'DATABASE_URL_INVALID' || /DATABASE_URL/.test(e.message)) wall = 'url-poison';
    }
    assert.notEqual(wall, 'MISSING', 'scan seam must be walled (fail-loud stub or poisoned DATABASE_URL)');
    if (wall === 'stub') {
      assert.equal(spanScanCalls, before + 1, 'a stub-route probe call must be counted');
    }
  });
});

after(() => {
  // Leave no stub or poisoned env behind for anything that runs after this file in
  // the same process (the runner gives each file its own process, but --test
  // isolation levels are a runner flag, not a guarantee). Restore the real
  // namespace captured at top level rather than deleting the entry.
  dbRequire.cache[DB_ENTRY] = realEntry;
  if (savedDatabaseUrl === undefined) delete env.DATABASE_URL;
  else env.DATABASE_URL = savedDatabaseUrl;
});
