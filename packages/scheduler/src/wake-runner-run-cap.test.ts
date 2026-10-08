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
import { runCapTiming, warnDroppedDeferredWakes } from './run-cap';

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

  it('cap removed while deferred: the next retry re-reads settings and the wake runs', async () => {
    setCap('company-a', 1);
    store.heartbeatRuns.push(running('r1', 'a2', 'company-a'));
    const started = await startWake(wake('a1', 'company-a'));
    assert.equal(started.deferred, true);
    setCap('company-a', undefined); // board clears the cap; r1 is still running
    const result = await started.done;
    assert.ok(result.runId, 'deferred wake ran without waiting for r1');
    assert.equal(rowsFor('a1').length, 1);
    assert.equal(store.heartbeatRuns.find((r) => r.id === 'r1')?.status, 'running');
  });

  it('agent paused while deferred: the retry skips it (no run), it is not started over the pause', async () => {
    setCap('company-a', 1);
    store.heartbeatRuns.push(running('r1', 'a2', 'company-a'));
    const started = await startWake(wake('a1', 'company-a'));
    assert.equal(started.deferred, true);
    store.agents.find((r) => r.id === 'a1')!.status = 'paused';
    store.heartbeatRuns[0].status = 'succeeded';
    const result = await started.done;
    assert.equal(result.status, 'skipped');
    assert.equal(rowsFor('a1').length, 0);
  });

  const wakeOf = (agentId: string, companyId: string, wakeReason: string, extra: Row = {}) =>
    ({ agentId, companyId, invocationSource: wakeReason, wakeReason, ...extra }) as never;
  const runOrder = () => store.heartbeatRuns.filter((r) => r.id !== 'r1').map((r) => r.agentId);
  const waitFor = async (pred: () => boolean) => {
    for (let i = 0; i < 300 && !pred(); i++) await sleep(10);
  };

  it('FIFO across agents: when slots free, the oldest deferred wake starts first', async () => {
    setCap('company-a', 1);
    store.heartbeatRuns.push(running('r1', 'a1', 'company-a'));
    const order = ['a3', 'a4', 'a2'];
    const starts = [];
    for (const id of order) {
      const s = await startWake(wakeOf(id, 'company-a', 'on_demand'));
      assert.equal(s.deferred, true);
      starts.push(s);
    }
    store.heartbeatRuns[0].status = 'succeeded';
    await Promise.all(starts.map((s) => s.done));
    assert.deepEqual(runOrder(), order);
    assert.ok((maxRunning['company-a'] ?? 0) <= 1);
  });

  it('coalescing: further wakes for a deferred agent merge into ONE entry; a non-timer wake wins over timers', async () => {
    setCap('company-a', 1);
    store.heartbeatRuns.push(running('r1', 'a2', 'company-a'));
    const first = await startWake(wakeOf('a1', 'company-a', 'timer'));
    assert.equal(first.deferred, true);
    const later = await startWake(wakeOf('a3', 'company-a', 'on_demand')); // queued behind a1
    const dupes = [
      await startWake(wakeOf('a1', 'company-a', 'on_demand')),
      await startWake(wakeOf('a1', 'company-a', 'timer')),
      await startWake(wakeOf('a1', 'company-a', 'on_demand')),
    ];
    for (const d of dupes) {
      assert.equal(d.status, 'queued');
      assert.equal(d.deferred, true);
      assert.match(d.errorText ?? '', /coalesced into deferred wake/);
    }
    store.heartbeatRuns[0].status = 'succeeded';
    await first.done;
    await later.done;
    await sleep(60); // no follow-up run appears for the coalesced wakes
    assert.equal(rowsFor('a1').length, 1, 'one run for a1');
    const snap = rowsFor('a1')[0].contextSnapshot as Row;
    assert.equal(snap.wakeReason, 'on_demand', 'the on-demand wake ran, not the timer');
    assert.deepEqual(runOrder(), ['a1', 'a3'], 'a1 kept its (earliest) place ahead of a3');
  });

  it('different targets are not merged: an assignment for another task still runs as a follow-up', async () => {
    setCap('company-a', 1);
    store.heartbeatRuns.push(running('r1', 'a2', 'company-a'));
    const first = await startWake(wakeOf('a1', 'company-a', 'on_demand'));
    assert.equal(first.deferred, true);
    const second = await startWake(wakeOf('a1', 'company-a', 'assignment', { taskId: 'task-9' }));
    assert.equal(second.status, 'queued');
    assert.notEqual(second.deferred, true, 'kept as the per-agent follow-up, not merged');
    store.heartbeatRuns[0].status = 'succeeded';
    await first.done;
    await waitFor(() => rowsFor('a1').length >= 2);
    assert.equal(rowsFor('a1').length, 2, 'the deferred wake ran, then its follow-up');
    assert.ok((maxRunning['company-a'] ?? 0) <= 1);
  });

  it('no starvation: repeated timer wakes never jump an older deferred wake, even right after a slot frees', async () => {
    setCap('company-a', 1);
    runCapTiming.baseMs = 150; // the deferred wake has not retried yet when the timers arrive
    runCapTiming.maxMs = 150;
    store.heartbeatRuns.push(running('r1', 'a2', 'company-a'));
    const onDemand = await startWake(wakeOf('a1', 'company-a', 'on_demand'));
    assert.equal(onDemand.deferred, true);
    store.heartbeatRuns[0].status = 'succeeded'; // slot is free, a1 is still sleeping
    const timers = [];
    for (let i = 0; i < 5; i++) {
      timers.push(await startWake(wakeOf('a3', 'company-a', 'timer')));
      await sleep(5);
    }
    assert.ok(timers.every((t) => t.deferred), 'every timer wake deferred behind a1');
    assert.equal(rowsFor('a3').length, 0, 'no timer run jumped the queue');
    await onDemand.done;
    await Promise.all(timers.map((t) => t.done));
    await waitFor(() => rowsFor('a3').length >= 1);
    assert.deepEqual(runOrder(), ['a1', 'a3'], 'a1 first, then ONE coalesced timer run');
  });

  it('shutdown: ONE warning line with the count, agentId + wake type of non-timer drops, timers counted; no payloads', async () => {
    setCap('company-a', 1);
    store.heartbeatRuns.push(running('r1', 'a2', 'company-a'));
    const silent: unknown[] = [];
    assert.equal(warnDroppedDeferredWakes({ warn: (...args) => silent.push(args) }), false);
    assert.equal(silent.length, 0, 'nothing deferred → no line');

    const starts = [
      await startWake(wakeOf('a1', 'company-a', 'on_demand', { wakePayloadJson: { note: 'sk-secret-123' } })),
      await startWake(wakeOf('a3', 'company-a', 'timer')),
      await startWake(wakeOf('a4', 'company-a', 'assignment', { taskId: 'task-secret-id' })),
    ];
    assert.ok(starts.every((s) => s.deferred));
    const lines: Array<[string, Record<string, unknown> | undefined]> = [];
    assert.equal(warnDroppedDeferredWakes({ warn: (m, d) => lines.push([m, d]) }), true);
    assert.equal(lines.length, 1, 'exactly one line');
    assert.match(lines[0][0], /shutdown/);
    assert.deepEqual(lines[0][1], {
      count: 3,
      timerCount: 1,
      dropped: [
        { agentId: 'a1', wakeType: 'on_demand' },
        { agentId: 'a4', wakeType: 'assignment' },
      ],
    });
    const text = JSON.stringify(lines);
    assert.doesNotMatch(text, /sk-secret|task-secret|a3/);

    store.heartbeatRuns[0].status = 'succeeded'; // drain so later tests start with an empty queue
    await Promise.all(starts.map((s) => s.done));
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
