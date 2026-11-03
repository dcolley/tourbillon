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
 * @tourbillon/db, drizzle-orm, ./redis-pub, ./park-helpers and all adapters are mocked via
 * Module.prototype.require (wake-runner.ts only), mirroring wake-runner-hermes.test.ts.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAgentTokenSignature } from '@tourbillon/shared/agent-token';

const SECRET = 'test-agent-token-secret-281-oc-0123456789abcdef';
const env = process.env as Record<string, string | undefined>;

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
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      if (!this?.filename?.endsWith('wake-runner.ts')) {
        return originalRequire.apply(this, arguments as unknown as [string]);
      }
      if (id === '@tourbillon/db') {
        return {
          db: fakeDb,
          ...tables,
          getLlmProviderRowById: async () => null,
          detectTruncatedGeneration: async () => ({ truncated: false }),
        };
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
  });
});
