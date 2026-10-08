/**
 * Company concurrent-run cap wired through startWake / triggerWake.
 * @tourbillon/db, drizzle-orm, ./redis-pub and ./adapters/harness-adapter are mocked via
 * Module.prototype.require (for wake-runner.ts only) so no database or Redis is touched.
 * The fake db.transaction is a mutex (stands in for the per-company advisory lock).
 * No TOURBILLON_AGENT_TOKEN_SECRET is set, so a started run inserts its heartbeat_runs row and then
 * fails fast on the run-token config error: "a row was inserted" is what "the run started" means here.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runCapTiming } from './run-cap';

const env = process.env as Record<string, string | undefined>;

type Row = Record<string, unknown>;
type Cond = { op: 'eq'; c: string; val: unknown } | { op: 'and'; xs: Cond[] } | { op: 'other' };
const match = (r: Row, c?: Cond): boolean =>
  !c || c.op === 'other' ? true : c.op === 'eq' ? r[c.c] === c.val : c.xs.every((x) => match(r, x));
const table = (name: string) =>
  new Proxy({}, { get: (_t, prop: string) => (prop === '__table' ? name : { c: prop, t: name }) });

const store: Record<string, Row[]> = {};
let txCount = 0;
let lockStatements = 0;
let updateDelayMs = 0;
/** Highest number of simultaneously `running` rows seen per company. */
const maxRunning: Record<string, number> = {};
const runningIn = (companyId: string) =>
  (store.heartbeatRuns ?? []).filter((r) => r.companyId === companyId && r.status === 'running').length;
const observe = () => {
  for (const r of store.heartbeatRuns ?? []) {
    const c = String(r.companyId);
    maxRunning[c] = Math.max(maxRunning[c] ?? 0, runningIn(c));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rowsFor = (agentId: string) => (store.heartbeatRuns ?? []).filter((r) => r.agentId === agentId);

describe('company concurrent-run cap (wake-runner)', () => {
  let startWake: typeof import('./wake-runner').startWake;
  let triggerWake: typeof import('./wake-runner').triggerWake;

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
      approvals: table('approvals'),
    };
    const insert = (t: { __table: string }) => ({
      values: async (row: Row) => {
        (store[t.__table] ??= []).push({ ...row });
        observe();
      },
    });
    const select = () => ({
      from: (t: { __table: string }) => ({
        where: async (where: Cond) => [{ n: (store[t.__table] ?? []).filter((r) => match(r, where)).length }],
      }),
    });
    let chain = Promise.resolve();
    const fakeDb = {
      query: new Proxy({}, {
        get: (_t, name: string) => ({
          findFirst: async ({ where }: { where?: Cond } = {}) => (store[name] ?? []).find((r) => match(r, where)),
        }),
      }),
      insert,
      select,
      update: (t: { __table: string }) => ({
        set: (patch: Row) => ({
          where: async (where: Cond) => {
            if (updateDelayMs && t.__table === 'heartbeatRuns') await sleep(updateDelayMs);
            for (const r of store[t.__table] ?? []) if (match(r, where)) Object.assign(r, patch);
            observe();
          },
        }),
      }),
      transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        const prev = chain;
        let release!: () => void;
        chain = new Promise<void>((r) => (release = r));
        await prev;
        txCount += 1;
        try {
          return await fn({ execute: async () => { lockStatements += 1; }, select, insert });
        } finally {
          release();
        }
      },
    };
    Module.prototype.require = function (this: { filename?: string }, id: string) {
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
        return { redisPub: { publish: async () => 1 } };
      }
      if (id === './adapters/harness-adapter' || id.endsWith('/adapters/harness-adapter')) {
        return { runWithHarness: async () => { throw new Error('harness must not run'); } };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ startWake, triggerWake } = await import('./wake-runner'));
  });

  const agent = (id: string, companyId: string): Row => ({
    id, companyId, name: id, urlKey: id, status: 'active',
    adapterType: 'harness', adapterConfig: {}, modelId: 'local/model', providerId: null,
    runtimeConfig: { timeout: { heartbeatSec: 300 } }, budgetMonthlyTokens: 1_000_000, spentMonthlyTokens: 0,
  });
  const running = (id: string, agentId: string, companyId: string): Row => ({ id, agentId, companyId, status: 'running' });
  const wake = (agentId: string, companyId: string) =>
    ({ agentId, companyId, invocationSource: 'on_demand', wakeReason: 'on_demand' }) as never;

  beforeEach(() => {
    delete env.TOURBILLON_AGENT_TOKEN_SECRET;
    runCapTiming.baseMs = 5;
    runCapTiming.maxMs = 20;
    txCount = 0;
    lockStatements = 0;
    updateDelayMs = 0;
    for (const k of Object.keys(maxRunning)) delete maxRunning[k];
    store.agents = [
      agent('a1', 'company-a'), agent('a2', 'company-a'), agent('a3', 'company-a'), agent('a4', 'company-a'),
      agent('b1', 'company-b'),
    ];
    store.companies = [
      { id: 'company-a', status: 'active', settings: {} },
      { id: 'company-b', status: 'active', settings: {} },
    ];
    store.heartbeatRuns = [];
  });

  const setCap = (companyId: string, cap: number | undefined) => {
    const c = store.companies.find((r) => r.id === companyId)!;
    c.settings = cap === undefined ? {} : { maxConcurrentRuns: cap };
  };

  it('no cap (unset): runs start as before, with no lock transaction', async () => {
    store.heartbeatRuns.push(running('r1', 'a2', 'company-a'), running('r2', 'a3', 'company-a'), running('r3', 'a4', 'company-a'));
    const result = await triggerWake(wake('a1', 'company-a'));
    assert.ok(result.runId, 'run created');
    assert.equal(rowsFor('a1').length, 1);
    assert.equal(txCount, 0);
  });

  it('under the cap: the run starts immediately (count + insert in one locked transaction)', async () => {
    setCap('company-a', 2);
    store.heartbeatRuns.push(running('r1', 'a2', 'company-a'));
    const started = await startWake(wake('a1', 'company-a'));
    assert.equal(started.status, 'started');
    assert.ok(started.runId);
    assert.equal(rowsFor('a1').length, 1);
    assert.equal(txCount, 1);
    assert.equal(lockStatements, 1, 'advisory lock statement issued inside the transaction');
    await started.done;
  });

  it('at the cap: the wake is deferred (202 queued), not failed, and runs once a slot frees', async () => {
    setCap('company-a', 1);
    store.heartbeatRuns.push(running('r1', 'a2', 'company-a'));
    const started = await startWake(wake('a1', 'company-a'));
    assert.equal(started.status, 'queued');
    assert.equal(started.deferred, true);
    assert.equal(started.runId, '');
    assert.match(started.errorText ?? '', /concurrent-run cap reached \(1\/1 running\)/);

    let settled = false;
    void started.done.then(() => (settled = true));
    await sleep(120); // many backoff rounds
    assert.equal(settled, false, 'still waiting for a slot');
    assert.equal(rowsFor('a1').length, 0, 'no run row while deferred');
    assert.equal(store.heartbeatRuns.filter((r) => r.status === 'failed').length, 0, 'nothing failed');

    store.heartbeatRuns[0].status = 'succeeded'; // slot frees (finished elsewhere)
    const result = await started.done;
    assert.ok(result.runId, 'deferred wake ran');
    assert.equal(rowsFor('a1').length, 1);
    assert.doesNotMatch(String(rowsFor('a1')[0].errorText ?? ''), /cap/);
  });

  it('triggerWake (timer path) reports deferred, and the wake still runs later', async () => {
    setCap('company-a', 1);
    store.heartbeatRuns.push(running('r1', 'a2', 'company-a'));
    const result = await triggerWake(wake('a1', 'company-a'));
    assert.equal(result.status, 'deferred');
    store.heartbeatRuns[0].status = 'succeeded';
    for (let i = 0; i < 100 && rowsFor('a1').length === 0; i++) await sleep(10);
    assert.equal(rowsFor('a1').length, 1);
  });

  it('company isolation: another company’s runs never count against this cap', async () => {
    setCap('company-a', 1);
    setCap('company-b', 1);
    store.heartbeatRuns.push(running('rb1', 'b1', 'company-b'), running('rb2', 'b1', 'company-b'));
    const a = await startWake(wake('a1', 'company-a'));
    assert.equal(a.status, 'started', 'company-a has 0/1 running');
    await a.done;

    // company-b is at its cap: b1 defers while company-a keeps starting runs
    store.heartbeatRuns.push(running('ra-live', 'a3', 'company-a'));
    setCap('company-a', 5);
    const b = await startWake(wake('b1', 'company-b'));
    assert.equal(b.deferred, true);
    const a2 = await startWake(wake('a2', 'company-a'));
    assert.equal(a2.status, 'started');
    await a2.done;
    assert.equal(rowsFor('b1').filter((r) => r.id !== 'rb1' && r.id !== 'rb2').length, 0);
    for (const r of store.heartbeatRuns) if (r.companyId === 'company-b') r.status = 'succeeded';
    const bResult = await b.done;
    assert.ok(bResult.runId);
  });

  it('a burst over the cap never exceeds it; every deferred wake eventually runs', async () => {
    setCap('company-a', 2);
    updateDelayMs = 25; // keep each run "running" briefly
    const starts = await Promise.all(['a1', 'a2', 'a3', 'a4'].map((id) => startWake(wake(id, 'company-a'))));
    assert.equal(starts.filter((s) => s.status === 'started').length, 2);
    assert.equal(starts.filter((s) => s.deferred).length, 2);
    const results = await Promise.all(starts.map((s) => s.done));
    assert.ok(results.every((r) => r.runId), 'all four ran');
    assert.equal(store.heartbeatRuns.length, 4);
    assert.ok((maxRunning['company-a'] ?? 0) <= 2, `max running ${maxRunning['company-a']} > cap 2`);
  });
});
