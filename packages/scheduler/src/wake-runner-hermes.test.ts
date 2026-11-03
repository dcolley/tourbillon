/**
 * #281: wake-runner routing between the in-product harness and the EXTERNAL Hermes bind.
 * Pins:
 *  1. adapterConfig.harness='hermes' + valid local bind → dispatchHermesHeartbeat receives the
 *     minted session token (signed pm_run_) and a LOOPBACK callbackBaseUrl derived from
 *     INTERNAL_API_URL; runWithHarness is never entered; the run row's contextSnapshot records
 *     harness.kind='hermes' + callbackBaseUrl.
 *  2. Malformed Hermes bind → run fails loudly ('Invalid Hermes harness bind'), NEITHER runtime
 *     is entered.
 *  3. Plain harness_local (no hermes key) → unchanged in-product path; Hermes dispatch never
 *     entered.
 *  4. S322-S2 (Refs #322): a completed external Hermes run NEVER calls the Mastra span
 *     scan detectTruncatedGeneration — the `if (!hermesBind && !opencodeBind)` guard at
 *     the harness branch of wake-runner.ts. The ./@tourbillon/db stub is fail-loud
 *     (counts + throws), so deleting the skip turns this file's happy-path test RED.
 * @tourbillon/db, drizzle-orm, ./redis-pub, ./park-helpers and both adapters are mocked via
 * Module.prototype.require (wake-runner.ts only), mirroring wake-runner-run-token.test.ts.
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAgentTokenSignature } from '@tourbillon/shared/agent-token';
import { createRequire } from 'node:module';

const SECRET = 'test-agent-token-secret-281-0123456789abcdef';
const env = process.env as Record<string, string | undefined>;
const dbRequire = createRequire(import.meta.url);
const DB_ENTRY = dbRequire.resolve('@tourbillon/db');
// ---- S322-S2: host-independent fail-loud wall on the span-scan seam ----
// See wake-runner-opencode.test.ts for the full rationale: capture the REAL
// namespace under valid env (lazy pool, no connect), poison DATABASE_URL so every
// later ESM load of '@tourbillon/db' rejects, and seed the fail-loud Proxy stub
// for the CJS route. A span-scan attempt on an external-bind run can never
// silently succeed, on any host.
const savedDatabaseUrl = env.DATABASE_URL;
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
let hermesCalls: { context: Record<string, unknown>; options: Record<string, unknown> }[] = [];
/**
 * S322-S2: every detectTruncatedGeneration call through the ./@tourbillon/db stub.
 * Must stay 0 for external harness runs — the stub THROWS (fail-loud), so removing
 * the span-scan-skip guard (`!hermesBind && !opencodeBind`) in wake-runner.ts makes
 * the wake fail instead of riding a benign `{ truncated: false }` stub.
 */
let spanScanCalls = 0;
const SPAN_SCAN_CALLED = 'detectTruncatedGeneration must never be called for an external harness run (S322-S2 span-scan-skip pin)';

describe('#281 wake-runner Hermes routing', () => {
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
    // hook below (measured: no hook hit for the dynamic form). Seed the same stub
    // into require.cache keyed by the resolved package entry so the dynamic seam
    // lands on the stub too (shared CJS/ESM cache; recipe from scheduler-main.test.ts).
    // The seam probe in wake-runner-opencode.test.ts guards this seam shape for both
    // files (identical seed code).
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
          dispatchHermesHeartbeat: async (context: Record<string, unknown>, options: Record<string, unknown>) => {
            hermesCalls.push({ context, options });
            return { threadId: 'hermes-run', transport: 'command', inputTokens: 0, outputTokens: 0, finishReason: 'complete' };
          },
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ triggerWake } = await import('./wake-runner'));
  });

  const baseAgent = (adapterConfig: Record<string, unknown>): Row => ({
    id: 'agent-h',
    companyId: 'company-h',
    name: 'Hermes Bound',
    urlKey: 'hermes-bound',
    status: 'active',
    adapterType: 'harness_local',
    adapterConfig,
    modelId: 'local/model',
    providerId: null,
    runtimeConfig: { timeout: { heartbeatSec: 300 } },
    budgetMonthlyTokens: 1_000_000,
    spentMonthlyTokens: 0,
  });

  beforeEach(() => {
    harnessCalls = 0;
    hermesCalls = [];
    spanScanCalls = 0;
    store.agents = [];
    store.companies = [{ id: 'company-h', status: 'active' }];
    store.heartbeatRuns = [];
  });

  it('valid Hermes local bind → dispatched with session token + loopback callbackUrl, in-product harness skipped', async () => {
    store.agents = [baseAgent({ harness: 'hermes', mode: 'local', command: 'hermes run' })];
    const result = await triggerWake({
      agentId: 'agent-h',
      companyId: 'company-h',
      invocationSource: 'on_demand',
      wakeReason: 'on_demand',
    } as never);

    assert.equal(result.status, 'succeeded', String(result.errorText));
    assert.equal(harnessCalls, 0, 'in-product AgentController must not run for a Hermes bind');
    assert.equal(hermesCalls.length, 1);
    // S322-S2: the completed Hermes run must not pay for the Mastra span scan — an
    // external dispatch writes no Mastra spans. The stub throws on ANY call, so
    // deleting the `if (!hermesBind && !opencodeBind)` skip REDs this test.
    assert.equal(spanScanCalls, 0, 'external Hermes run must never call detectTruncatedGeneration');

    const { context, options } = hermesCalls[0];
    // EVERY heartbeat carries the minted run token + loopback callback origin.
    const claims = verifyAgentTokenSignature(context.apiKey as string);
    assert.ok(claims && claims.kind === 'run', 'session token must be a signed pm_run_ token');
    assert.equal(claims.runId, result.runId);
    assert.equal(claims.agentId, 'agent-h');
    assert.equal(options.callbackBaseUrl, 'http://127.0.0.1:3002', 'localhost INTERNAL_API_URL normalises to loopback');
    assert.equal((options.bind as { mode: string }).mode, 'local');
    assert.ok(typeof context.wakeMessage === 'string' && (context.wakeMessage as string).length > 0);

    const run = store.heartbeatRuns.find((r) => r.id === result.runId);
    assert.ok(run);
    assert.equal(run.status, 'succeeded');
    const snapshot = run.contextSnapshot as { harness?: { kind: string; callbackBaseUrl: string } };
    assert.equal(snapshot.harness?.kind, 'hermes');
    assert.equal(snapshot.harness?.callbackBaseUrl, 'http://127.0.0.1:3002');
  });

  it('malformed Hermes bind → run fails loudly; NEITHER runtime is entered', async () => {
    store.agents = [baseAgent({ harness: 'hermes', mode: 'local' })]; // no command/localBaseUrl
    const result = await triggerWake({
      agentId: 'agent-h',
      companyId: 'company-h',
      invocationSource: 'on_demand',
      wakeReason: 'on_demand',
    } as never);

    assert.equal(result.status, 'failed');
    assert.match(result.errorText ?? '', /Invalid Hermes harness bind/);
    assert.equal(harnessCalls, 0, 'a broken Hermes bind must not silently fall back to the in-product harness');
    assert.equal(hermesCalls.length, 0);
    const run = store.heartbeatRuns.find((r) => r.id === result.runId);
    assert.equal(run?.status, 'failed');
    assert.match(String(run?.errorText), /Invalid Hermes harness bind/);
  });

  it('plain harness_local (no hermes key) → in-product harness path unchanged', async () => {
    store.agents = [baseAgent({ provider: 'lmstudio' })];
    const result = await triggerWake({
      agentId: 'agent-h',
      companyId: 'company-h',
      invocationSource: 'on_demand',
      wakeReason: 'on_demand',
    } as never);

    // The in-product stub returns finishReason 'error' (see interceptor) — routing is the pin:
    // it went to runWithHarness, not the Hermes dispatcher.
    assert.equal(result.status, 'failed');
    assert.match(result.errorText ?? '', /Harness run failed/);
    assert.equal(harnessCalls, 1);
    assert.equal(hermesCalls.length, 0, 'non-Hermes harness agents never touch the Hermes dispatcher');
    const run = store.heartbeatRuns.find((r) => r.id === result.runId);
    const snapshot = run?.contextSnapshot as { harness?: unknown };
    assert.equal(snapshot.harness, undefined, 'no hermes stamp on in-product runs');
  });
});

after(() => {
  // Leave no stub or poisoned env behind (mirror of the OpenCode file). Restore
  // the real namespace captured at top level rather than deleting the entry.
  dbRequire.cache[DB_ENTRY] = realEntry;
  if (savedDatabaseUrl === undefined) delete env.DATABASE_URL;
  else env.DATABASE_URL = savedDatabaseUrl;
});
