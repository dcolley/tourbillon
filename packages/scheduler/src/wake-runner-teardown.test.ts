/**
 * The wake runner releases per-wake resources (code-execution workspace and the
 * `browser` toolset's Chromium) on every exit path of a durable-agent wake, with the
 * run row recorded in the (fake) database.
 *
 * @tourbillon/db, drizzle-orm, ./redis-pub, ./adapters/harness-adapter, ./wake-teardown
 * and the agent factory in @tourbillon/mastra are swapped via Module.prototype.require
 * (for scheduler modules only) so no database, Redis, LLM or browser is touched.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const SECRET = 'test-agent-token-secret-teardown-0123456789abcdef';
const env = process.env as Record<string, string | undefined>;

type Row = Record<string, unknown>;
type Cond = { op: 'eq'; c: string; val: unknown } | { op: 'and'; xs: Cond[] } | { op: 'other' };
const match = (r: Row, c?: Cond): boolean =>
  !c || c.op === 'other' ? true : c.op === 'eq' ? r[c.c] === c.val : c.xs.every((x) => match(r, x));
const table = (name: string) =>
  new Proxy({}, { get: (_t, prop: string) => (prop === '__table' ? name : { c: prop, t: name }) });

const store: Record<string, Row[]> = {};
const released: unknown[] = [];
const events: string[] = [];
let streamImpl: (opts: { abortSignal: AbortSignal }) => Promise<unknown>;

function fakeDurableAgent() {
  return {
    id: 'durable-agent',
    stream: (_msg: string, opts: { abortSignal: AbortSignal }) => streamImpl(opts),
    getWorkspace: async () => undefined,
  };
}

describe('wake runner releases wake resources (fake DB)', () => {
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
    const realMastra = originalRequire.call(module, '@tourbillon/mastra');
    const mastra = {
      ...realMastra,
      createDurableAgentWithSkills: async () => fakeDurableAgent(),
      clearAllHeartbeatThreads: async () => undefined,
      persistDurableRunId: async () => void events.push('persistDurableRunId'),
      flushObservability: async () => undefined,
      getResumableDurableRun: async () => null,
    };
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      // Scheduler modules (wake-runner and its helpers) see the fakes; everything else
      // loads the real modules.
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
        return {
          releaseWakeResources: async (agents: unknown) => {
            events.push('releaseWakeResources');
            released.push(agents);
          },
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ triggerWake } = await import('./wake-runner'));
  });

  beforeEach(() => {
    env.TOURBILLON_AGENT_TOKEN_SECRET = SECRET;
    released.length = 0;
    events.length = 0;
    store.agents = [{
      id: 'agent-b', companyId: 'company-b', name: 'Bea', urlKey: 'bea', status: 'active', assignedSkills: [],
      adapterType: 'mastra', adapterConfig: {}, modelId: 'local/model', providerId: null,
      runtimeConfig: { timeout: { heartbeatSec: 300 }, toolsets: ['browser'] },
      budgetMonthlyTokens: 1_000_000, spentMonthlyTokens: 0,
    }];
    store.companies = [{ id: 'company-b', status: 'active', settings: {}, allowedMcpServerIds: [] }];
    store.heartbeatRuns = [];
  });

  const wake = () =>
    triggerWake({ agentId: 'agent-b', companyId: 'company-b', invocationSource: 'on_demand', wakeReason: 'manual' } as never);

  it('stream fails: run row failed, resources released once for the durable agent', async () => {
    streamImpl = async () => {
      throw new Error('model exploded');
    };
    const result = await wake();
    assert.equal(result.status, 'failed', String(result.errorText));
    assert.equal(store.heartbeatRuns.length, 1);
    assert.equal(store.heartbeatRuns[0]!.status, 'failed', JSON.stringify({ events, row: store.heartbeatRuns[0] }));
    assert.equal(released.length, 1);
    assert.equal((released[0] as { id?: string }).id, 'durable-agent');
  });

  it('wall-clock timeout aborts the stream: resources still released', async () => {
    (store.agents[0]!.runtimeConfig as { timeout: { heartbeatSec: number } }).timeout.heartbeatSec = 1;
    streamImpl = ({ abortSignal }) =>
      new Promise((_resolve, reject) => {
        abortSignal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    const result = await wake();
    assert.equal(result.status, 'failed');
    assert.equal(store.heartbeatRuns[0]!.status, 'failed');
    assert.equal(released.length, 1);
  });

  it('stream succeeds: resources released before the run is finalised', async () => {
    streamImpl = async () => ({
      runId: 'durable-run-1',
      output: { text: Promise.resolve('done') },
      cleanup: () => undefined,
    });
    await wake();
    assert.equal(released.length, 1);
    assert.ok(events.indexOf('releaseWakeResources') < events.indexOf('persistDurableRunId'), events.join(','));
  });
});
