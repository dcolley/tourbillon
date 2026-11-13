/**
 * A down/rejecting/hanging observability collector must never fail a heartbeat
 * (TEST incident: ECONNREFUSED wake failures while Phoenix was offline).
 *
 * `@tourbillon/db`, drizzle-orm, ./redis-pub, ./adapters/harness-adapter,
 * ./wake-teardown and @tourbillon/mastra are swapped via Module.prototype.require
 * (for scheduler modules only). `flushObservability` is driven per-test:
 *  - a rejection there must still leave the run row `succeeded` (wake-runner guard);
 *  - the failure path is unchanged (still records `failed`);
 *  - with the real shared safe-flush against a rejecting collector, the wake stays
 *    `succeeded` and a warning is logged;
 *  - with a hanging collector, the flush is bounded and the wake still completes.
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { flushUnitsSafely, type FlushUnit } from '@tourbillon/shared';

const SECRET = 'test-agent-token-secret-flush-0123456789abcdef';
const env = process.env as Record<string, string | undefined>;

type Row = Record<string, unknown>;
type Cond = { op: 'eq'; c: string; val: unknown } | { op: 'and'; xs: Cond[] } | { op: 'other' };
const match = (r: Row, c?: Cond): boolean =>
  !c || c.op === 'other' ? true : c.op === 'eq' ? r[c.c] === c.val : c.xs.every((x) => match(r, x));
const table = (name: string) =>
  new Proxy({}, { get: (_t, prop: string) => (prop === '__table' ? name : { c: prop, t: name }) });

const store: Record<string, Row[]> = {};
const events: string[] = [];
let streamImpl: (opts: { abortSignal: AbortSignal }) => Promise<unknown>;
let flushImpl: () => Promise<void> = async () => undefined;
const warnings: string[] = [];

function fakeDurableAgent() {
  return {
    id: 'durable-agent',
    stream: (_msg: string, opts: { abortSignal: AbortSignal }) => streamImpl(opts),
    getWorkspace: async () => undefined,
  };
}

describe('wake runner survives observability flush trouble (fake DB)', () => {
  let triggerWake: typeof import('./wake-runner').triggerWake;

  before(async () => {
    env.OBSERVABILITY_ENABLED = 'true'; // isMastraTracingEnabled() gates the flush calls
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
    const chain = (rows: () => Row[]): any =>
      new Proxy(
        {},
        {
          get: (_t, prop: string) =>
            prop === 'then' ? (res: (v: Row[]) => void) => res(rows()) : () => chain(rows),
        },
      );
    const fakeDb = {
      query: new Proxy({}, {
        get: (_t, name: string) => ({
          findFirst: async ({ where }: { where?: Cond } = {}) => (store[name] ?? []).find((r) => match(r, where)),
          findMany: async ({ where }: { where?: Cond } = {}) => (store[name] ?? []).filter((r) => match(r, where)),
        }),
      }),
      insert: (t: { __table: string }) => ({
        values: (row: Row) => {
          (store[t.__table] ??= []).push({ ...row });
          return chain(() => [row]);
        },
      }),
      update: (t: { __table: string }) => ({
        set: (patch: Row) => ({
          where: (where: Cond) => {
            events.push(`db:update:${t.__table}:${String(patch.status ?? '')}`);
            for (const r of store[t.__table] ?? []) if (match(r, where)) Object.assign(r, patch);
            return chain(() => []);
          },
        }),
      }),
      select: () => chain(() => []),
      execute: async () => ({ rows: [] }),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb),
    };
    // Durable-path `await import('@tourbillon/db')` bypasses the require hook — neutralize
    // the real singleton's only used entry point (same instance every import path sees),
    // so detectTruncatedGeneration's span scan reads an empty set instead of Postgres.
    const realDbModule = originalRequire.call(module, '@tourbillon/db');
    realDbModule.db.select = () => chain(() => []);
    const realMastra = originalRequire.call(module, '@tourbillon/mastra');
    const mastra = {
      ...realMastra,
      createDurableAgentWithSkills: async () => fakeDurableAgent(),
      clearAllHeartbeatThreads: async () => undefined,
      persistDurableRunId: async () => void events.push('persistDurableRunId'),
      flushObservability: () => flushImpl(),
      getResumableDurableRun: async () => null,
    };
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      const file = this?.filename ?? '';
      if (!file.includes('/packages/scheduler/src/') || file.endsWith('.test.ts')) {
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
      if (id === '@tourbillon/mastra') return mastra;
      if (id === './redis-pub' || id.endsWith('/redis-pub')) {
        return { redisPub: { publish: async () => 1 } };
      }
      if (id === './adapters/harness-adapter' || id.endsWith('/adapters/harness-adapter')) {
        return { runWithHarness: async () => { throw new Error('harness must not run'); } };
      }
      if (id === './wake-teardown' || id.endsWith('/wake-teardown')) {
        return { releaseWakeResources: async () => { events.push('releaseWakeResources'); } };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ triggerWake } = await import('./wake-runner'));
  });

  const realWarn = console.warn;
  beforeEach(() => {
    env.TOURBILLON_AGENT_TOKEN_SECRET = SECRET;
    events.length = 0;
    warnings.length = 0;
    flushImpl = async () => undefined;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    store.agents = [{
      id: 'agent-f', companyId: 'company-f', name: 'Fay', urlKey: 'fay', status: 'active', assignedSkills: [],
      adapterType: 'mastra', adapterConfig: {}, modelId: 'local/model', providerId: null,
      runtimeConfig: { timeout: { heartbeatSec: 300 }, toolsets: [] },
      budgetMonthlyTokens: 1_000_000, spentMonthlyTokens: 0,
    }];
    store.companies = [{ id: 'company-f', status: 'active', settings: {}, allowedMcpServerIds: [] }];
    store.heartbeatRuns = [];
  });

  afterEach(() => {
    console.warn = realWarn;
  });

  const wake = () =>
    triggerWake({ agentId: 'agent-f', companyId: 'company-f', invocationSource: 'on_demand', wakeReason: 'manual' } as never);

  const succeedStream = () => {
    streamImpl = async () => ({
      runId: 'durable-run-f',
      output: { text: Promise.resolve('done') },
      cleanup: () => undefined,
    });
  };

  it('success path: flush rejection leaves the run row `succeeded` (guard)', async () => {
    succeedStream();
    flushImpl = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:4317'); };
    const result = await wake();
    assert.equal(result.status, 'succeeded', String(result.errorText));
    assert.equal(store.heartbeatRuns.length, 1);
    assert.equal(store.heartbeatRuns[0]!.status, 'succeeded', JSON.stringify({ events, row: store.heartbeatRuns[0] }));
  });

  it('failure path unchanged: stream failure still records `failed` even when flush also throws', async () => {
    streamImpl = async () => { throw new Error('model exploded'); };
    flushImpl = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:4317'); };
    const result = await wake();
    assert.equal(result.status, 'failed');
    assert.equal(store.heartbeatRuns[0]!.status, 'failed', JSON.stringify({ events, row: store.heartbeatRuns[0] }));
  });

  it('real safe-flush vs rejecting collector: wake stays `succeeded` and a warning is logged', async () => {
    succeedStream();
    const units: FlushUnit[] = [
      { label: 'exporter:arize', flush: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:6006')) },
      { label: 'exporter:postgres', flush: async () => { events.push('postgres-flushed'); } },
    ];
    flushImpl = () => flushUnitsSafely(units, { timeoutMs: 1000 });
    const result = await wake();
    assert.equal(result.status, 'succeeded', String(result.errorText));
    assert.equal(store.heartbeatRuns[0]!.status, 'succeeded');
    assert.ok(events.includes('postgres-flushed'), 'postgres exporter still flushed');
    assert.ok(
      warnings.some((w) => w.includes('exporter:arize') && w.includes('flush failed') && w.includes('ECONNREFUSED')),
      `expected an arize flush warning; got ${JSON.stringify(warnings)}`,
    );
  });

  it('hanging collector is bounded: wake completes quickly, flush timeout warned', async () => {
    succeedStream();
    const units: FlushUnit[] = [
      { label: 'exporter:hang', flush: () => new Promise(() => undefined) },
    ];
    flushImpl = () => flushUnitsSafely(units, { timeoutMs: 150 });
    const started = Date.now();
    const result = await wake();
    const elapsed = Date.now() - started;
    assert.equal(result.status, 'succeeded', String(result.errorText));
    assert.equal(store.heartbeatRuns[0]!.status, 'succeeded');
    assert.ok(elapsed < 5000, `wake bounded despite hung collector (took ${elapsed}ms)`);
    assert.ok(
      warnings.some((w) => w.includes('exporter:hang') && w.includes('timed out')),
      `expected a flush timeout warning; got ${JSON.stringify(warnings)}`,
    );
  });
});
