/**
 * WC6 AC2 telemetry: the heartbeat_runs insert carries contextSnapshot.wakeContext with the
 * section sizes and counts. Same isolation as wake-runner-run-token.test.ts: @tourbillon/db,
 * drizzle-orm, ./redis-pub and ./adapters/harness-adapter are faked for wake-runner.ts only, and
 * ./wake-context's drizzle repo is swapped for an in-memory one over the TOUR-531 fixture.
 * No token secret is set, so each run stops (failed) right after the insert, before any model call.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadTour531Fixture,
  tour531Job,
} from '../../shared/src/wake-context/__fixtures__/tour-531';
import type { WakeContextRepo } from './wake-context';

type Row = Record<string, unknown>;
type Cond = { op: 'eq'; c: string; val: unknown } | { op: 'and'; xs: Cond[] } | { op: 'other' };
const match = (r: Row, c?: Cond): boolean =>
  !c || c.op === 'other' ? true : c.op === 'eq' ? r[c.c] === c.val : c.xs.every((x) => match(r, x));
const table = (name: string) =>
  new Proxy({}, { get: (_t, prop: string) => (prop === '__table' ? name : { c: prop, t: name }) });

const env = process.env as Record<string, string | undefined>;
const store: Record<string, Row[]> = {};
const fx = loadTour531Fixture();
let repoMode: 'ok' | 'throw' = 'ok';

const fixtureRepo = (): WakeContextRepo => ({
  async getIssue(companyId, id) {
    if (repoMode === 'throw') throw new Error('relation "approvals" does not exist');
    return (fx.issues.find((i) => i.id === id && i.companyId === companyId) as never) ?? null;
  },
  async getIssuesByIds(companyId, ids) { return fx.issues.filter((i) => i.companyId === companyId && ids.includes(i.id)) as never; },
  async getIssuesByIdentifiers(companyId, ids) { return fx.issues.filter((i) => i.companyId === companyId && ids.includes(i.identifier)) as never; },
  async getAgentName() { return null; },
  async getLinkedApprovals(companyId, issueId) { return fx.approvals.filter((a) => a.companyId === companyId && a.issueIds.includes(issueId)); },
  async getApprovalsByIdPrefixes(companyId, prefixes) { return fx.approvals.filter((a) => a.companyId === companyId && prefixes.some((p) => a.id.startsWith(p))); },
  async getAgentLastActivityAt(_c, agentId, _i, before) {
    const xs = fx.activity.filter((a) => a.actorId === agentId && Date.parse(a.createdAt) < before.getTime()).map((a) => a.createdAt).sort();
    return xs.length ? new Date(xs[xs.length - 1]) : null;
  },
  async countUserCommentsSince() { return 0; },
});

describe('WC6 wake-runner records contextSnapshot.wakeContext', () => {
  let triggerWake: typeof import('./wake-runner').triggerWake;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    const tables = {
      agents: table('agents'), companies: table('companies'), heartbeatRuns: table('heartbeatRuns'), issues: table('issues'),
      costEvents: table('costEvents'), activityLog: table('activityLog'), approvals: table('approvals'),
    };
    const fakeDb = {
      query: new Proxy({}, {
        get: (_t, name: string) => ({
          findFirst: async ({ where }: { where?: Cond } = {}) => (store[name] ?? []).find((r) => match(r, where)),
        }),
      }),
      insert: (t: { __table: string }) => ({ values: async (row: Row) => { (store[t.__table] ??= []).push({ ...row }); } }),
      update: (t: { __table: string }) => ({
        set: (patch: Row) => ({ where: async (where: Cond) => { for (const r of store[t.__table] ?? []) if (match(r, where)) Object.assign(r, patch); } }),
      }),
      select: () => ({ from: () => ({ where: async () => [] }) }),
    };
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      if (!this?.filename?.endsWith('wake-runner.ts')) return originalRequire.apply(this, arguments as unknown as [string]);
      if (id === '@tourbillon/db') return { db: fakeDb, ...tables, getLlmProviderRowById: async () => null, getDefaultLlmProviderRow: async () => null };
      if (id === 'drizzle-orm') {
        return {
          eq: (col: { c: string }, val: unknown) => ({ op: 'eq', c: col.c, val }),
          and: (...xs: Cond[]) => ({ op: 'and', xs }),
          sql: () => ({ op: 'other' }),
          lt: () => ({ op: 'other' }),
        };
      }
      if (id === './redis-pub' || id.endsWith('/redis-pub')) return { redisPub: { publish: async () => 1 } };
      if (id === './adapters/harness-adapter' || id.endsWith('/adapters/harness-adapter')) {
        return { runWithHarness: async () => { throw new Error('harness must not run'); } };
      }
      if (id === './wake-context') {
        const real = originalRequire.apply(this, arguments as unknown as [string]);
        return { ...real, createDrizzleWakeContextRepo: () => fixtureRepo() };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ triggerWake } = await import('./wake-runner'));
  });

  beforeEach(() => {
    delete env.TOURBILLON_AGENT_TOKEN_SECRET;
    delete env.TOURBILLON_WAKE_CONTEXT_V2;
    repoMode = 'ok';
    store.agents = [{
      id: fx.agent.id, companyId: fx.companyId, name: fx.agent.name, urlKey: fx.agent.urlKey, status: 'active',
      adapterType: 'harness', adapterConfig: {}, modelId: 'local/model', providerId: null,
      runtimeConfig: { timeout: { heartbeatSec: 300 } }, budgetMonthlyTokens: 1_000_000, spentMonthlyTokens: 0,
    }];
    store.companies = [{ id: fx.companyId, status: 'active', settings: { wakeContextV2: true } }];
    store.issues = fx.issues.map((i) => ({ ...i }));
    store.heartbeatRuns = [];
  });

  const run = async () => {
    const result = await triggerWake(tour531Job(fx));
    assert.equal(store.heartbeatRuns.length, 1);
    assert.equal(result.status, 'failed', 'stops at the token mint (no secret) — after the insert');
    return (store.heartbeatRuns[0].contextSnapshot as Record<string, unknown>).wakeContext as Record<string, unknown>;
  };

  it('flag on: insert carries v2 counts, section sizes, approvals listed and the message hash', async () => {
    const wc = await run();
    assert.equal(wc.mode, 'v2');
    assert.equal(wc.enabled, true);
    assert.equal(wc.version, 1);
    assert.equal(wc.considered, 10);
    assert.equal(wc.hidden, 2);
    assert.equal(wc.deduped, 1);
    assert.ok((wc.annotated as number) >= 11);
    assert.ok((wc.headerChars as number) > 0 && (wc.headerChars as number) <= 2400);
    assert.ok((wc.commentChars as number) > 0 && (wc.commentChars as number) <= 4500);
    assert.ok((wc.totalChars as number) <= 7500);
    assert.equal((wc.approvalsListed as string[]).length, 10);
    assert.match(String(wc.messageSha256), /^[0-9a-f]{64}$/);
  });

  it('context read fails: run still created, T1 counts recorded with the error', async () => {
    repoMode = 'throw';
    const wc = await run();
    assert.equal(wc.mode, 't1');
    assert.equal(wc.enabled, true);
    assert.match(String(wc.error), /does not exist/);
    assert.equal(wc.considered, 10);
    assert.equal(wc.headerChars, 0);
  });

  it('flag off: T1 counts recorded, no context read', async () => {
    store.companies = [{ id: fx.companyId, status: 'active', settings: {} }];
    repoMode = 'throw'; // would surface as an error if the repo were touched
    const wc = await run();
    assert.equal(wc.mode, 't1');
    assert.equal(wc.enabled, false);
    assert.equal(wc.error, undefined);
  });
});
