/**
 * #110: wake-runner run-token mint site.
 * - No TOURBILLON_AGENT_TOKEN_SECRET → the run row is marked failed with the config error, the
 *   harness/LLM path is never entered and no (unsigned) token is minted.
 * - With a secret, buildRunScopedApiKey mints a signed token whose TTL tracks the effective wall
 *   clock (heartbeatSec + 15 min grace, heartbeatSec <= 0 or > 23h capped at 23h).
 * @tourbillon/db, drizzle-orm, ./redis-pub and ./adapters/harness-adapter are mocked via
 * Module.prototype.require (for wake-runner.ts only) so no database or Redis is touched.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAgentTokenSignature, RUN_TOKEN_GRACE_SEC } from '@tourbillon/shared/agent-token';
import { MAX_HEARTBEAT_TIMEOUT_SEC } from '@tourbillon/shared';

const SECRET = 'test-agent-token-secret-110-0123456789abcdef';
const env = process.env as Record<string, string | undefined>;

type Row = Record<string, unknown>;
type Cond = { op: 'eq'; c: string; val: unknown } | { op: 'and'; xs: Cond[] } | { op: 'other' };
const match = (r: Row, c?: Cond): boolean =>
  !c || c.op === 'other' ? true : c.op === 'eq' ? r[c.c] === c.val : c.xs.every((x) => match(r, x));
const table = (name: string) =>
  new Proxy({}, { get: (_t, prop: string) => (prop === '__table' ? name : { c: prop, t: name }) });

const store: Record<string, Row[]> = {};
const published: string[] = [];
let harnessCalls = 0;

describe('#110 wake-runner run token', () => {
  let triggerWake: typeof import('./wake-runner').triggerWake;
  let buildRunScopedApiKey: typeof import('./wake-runner').buildRunScopedApiKey;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    const tables = {
      agents: table('agents'),
      companies: table('companies'),
      heartbeatRuns: table('heartbeatRuns'),
      issues: table('issues'),
      costEvents: table('costEvents'),
      activityLog: table('activityLog'),
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
            for (const r of store[t.__table] ?? []) if (match(r, where)) Object.assign(r, patch);
          },
        }),
      }),
    };
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      // Only wake-runner itself sees the fakes; everything else loads the real modules.
      if (!this?.filename?.endsWith('wake-runner.ts')) {
        return originalRequire.apply(this, arguments as unknown as [string]);
      }
      if (id === '@tourbillon/db') {
        return { db: fakeDb, ...tables, getLlmProviderRowById: async () => null };
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
        return { redisPub: { publish: async (channel: string) => { published.push(channel); return 1; } } };
      }
      if (id === './adapters/harness-adapter' || id.endsWith('/adapters/harness-adapter')) {
        return { runWithHarness: async () => { harnessCalls += 1; throw new Error('harness must not run'); } };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ triggerWake, buildRunScopedApiKey } = await import('./wake-runner'));
  });

  beforeEach(() => {
    delete env.TOURBILLON_AGENT_TOKEN_SECRET;
    published.length = 0;
    harnessCalls = 0;
    store.agents = [{
      id: 'agent-a', companyId: 'company-a', name: 'Alice', urlKey: 'alice', status: 'active',
      adapterType: 'harness', adapterConfig: {}, modelId: 'local/model', providerId: null,
      runtimeConfig: { timeout: { heartbeatSec: 300 } }, budgetMonthlyTokens: 1_000_000, spentMonthlyTokens: 0,
    }];
    store.companies = [{ id: 'company-a', status: 'active' }];
    store.heartbeatRuns = [];
  });

  it('no secret: the run is recorded as failed with the config error and never reaches the harness', async () => {
    const result = await triggerWake({
      agentId: 'agent-a', companyId: 'company-a', invocationSource: 'on_demand', wakeReason: 'manual',
    } as never);
    assert.equal(result.status, 'failed', String(result.errorText));
    assert.match(result.errorText ?? '', /TOURBILLON_AGENT_TOKEN_SECRET is not set/);
    assert.equal(store.heartbeatRuns.length, 1);
    const run = store.heartbeatRuns[0];
    assert.equal(run.id, result.runId);
    assert.equal(run.status, 'failed');
    assert.match(String(run.errorText), /TOURBILLON_AGENT_TOKEN_SECRET is not set/);
    assert.ok(run.finishedAt instanceof Date);
    assert.equal(harnessCalls, 0, 'harness/LLM path must not start without a token');
    assert.deepEqual(published, ['sse:company-a']);
  });

  it('no secret / short secret: buildRunScopedApiKey throws instead of minting', () => {
    assert.throws(() => buildRunScopedApiKey('run-1', 'agent-a', 'company-a', 300), /TOURBILLON_AGENT_TOKEN_SECRET/);
    env.TOURBILLON_AGENT_TOKEN_SECRET = 'too-short';
    assert.throws(() => buildRunScopedApiKey('run-1', 'agent-a', 'company-a', 300), /TOURBILLON_AGENT_TOKEN_SECRET/);
  });

  it('with a secret: signed run token, TTL = effective wall clock + grace (heartbeatSec 0 / huge capped at 23h)', () => {
    env.TOURBILLON_AGENT_TOKEN_SECRET = SECRET;
    const ttl = (timeoutSec: unknown) => {
      const claims = verifyAgentTokenSignature(buildRunScopedApiKey('run-1', 'agent-a', 'company-a', timeoutSec));
      assert.ok(claims && claims.kind === 'run');
      assert.equal(claims.runId, 'run-1');
      return claims.exp - claims.iat;
    };
    assert.equal(ttl(300), 300 + RUN_TOKEN_GRACE_SEC);
    assert.equal(ttl(undefined), 300 + RUN_TOKEN_GRACE_SEC);
    assert.equal(ttl(0), MAX_HEARTBEAT_TIMEOUT_SEC + RUN_TOKEN_GRACE_SEC);
    assert.equal(ttl(10 * 86400), MAX_HEARTBEAT_TIMEOUT_SEC + RUN_TOKEN_GRACE_SEC);
    assert.ok(ttl(0) < 86400, 'token always fits the 24h cap and outlives the wall clock');
  });
});
