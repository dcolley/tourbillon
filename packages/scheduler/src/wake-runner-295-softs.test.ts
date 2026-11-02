/**
 * #295 softs (S1/S2/S4) scheduler pins on wake-runner, fake DB, no LLM:
 *
 *  S295-S2 — every member of the shared TASK_SCOPED_WAKE_REASONS must gate the #275
 *  assignee-mismatch pre-flight. The old suite only exercised `assignment` and
 *  `issue_commented`, so dropping `issue_comment_mentioned`, `issue_blockers_resolved` or
 *  `issue_children_completed` from the set survived the whole suite (a mismatched wake of
 *  that reason would run the model as a non-assignee — the #275 bug, reintroduced per
 *  member). The loop runs over the live set AND asserts its exact membership, so dropping a
 *  member fails the membership assertion, not just a vanished test.
 *
 *  S295-S4 — recordHeartbeatFailure's already-terminal guard must use the shared
 *  TERMINAL_HEARTBEAT_STATUSES: a run that is already `skipped` / `coalesced` (not just
 *  succeeded/failed/cancelled) must never be repainted `failed` by a late failure record,
 *  and must not publish a red SSE update. `running` stays settleable (that is what the
 *  stale sweeps rely on).
 *
 *  S299-S1 (#299) — recordHeartbeatSkip's guard must read the SAME shared set (it
 *  hand-listed succeeded/failed/cancelled/skipped and omitted `coalesced`, so a late skip
 *  could repaint a coalesced run). Per-status pins below: for every terminal status the
 *  #275 assignee-mismatch pre-flight must be a true no-op — no row update at all
 *  (status, errorText, finishedAt untouched) and no `skipped` SSE fan-out. `queued`
 *  stays settleable so the pins cannot be satisfied by a guard that always returns.
 *
 * Fake-DB pattern copied from wake-runner-assignee-275.test.ts (Module.prototype.require
 * swap scoped to scheduler modules).
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { WakeReason } from '@tourbillon/shared';
import { TASK_SCOPED_WAKE_REASONS, TERMINAL_HEARTBEAT_STATUSES } from '@tourbillon/shared';

const SECRET = 'test-agent-token-secret-295-0123456789abcdef';
const env = process.env as Record<string, string | undefined>;

type Row = Record<string, unknown>;
type Cond = { op: 'eq'; c: string; val: unknown } | { op: 'and'; xs: Cond[] } | { op: 'other' };
const match = (r: Row, c?: Cond): boolean =>
  !c || c.op === 'other' ? true : c.op === 'eq' ? r[c.c] === c.val : c.xs.every((x) => match(r, x));
const table = (name: string) =>
  new Proxy({}, { get: (_t, prop: string) => (prop === '__table' ? name : { c: prop, t: name }) });

const store: Record<string, Row[]> = {};
const published: Array<{ channel: string; message: string }> = [];
let streamCalls = 0;

/** Canonical five, written independently of the shared set (see the membership pin below). */
const CANONICAL_TASK_SCOPED = [
  'assignment',
  'issue_commented',
  'issue_comment_mentioned',
  'issue_blockers_resolved',
  'issue_children_completed',
];

describe('#295 wake-runner task-scoped assignee gate + terminal failure guard (fake DB)', () => {
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
    // the real singleton's only used entry point (same instance every import path sees).
    const realDbModule = originalRequire.call(module, '@tourbillon/db');
    realDbModule.db.select = () => chain(() => []);
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
      if (id === './redis-pub' || id.endsWith('/redis-pub')) {
        return {
          redisPub: {
            publish: async (channel: string, message: string) => {
              published.push({ channel, message });
              return 1;
            },
          },
        };
      }
      if (id === '@tourbillon/mastra') {
        const realMastra = originalRequire.call(module, '@tourbillon/mastra');
        return {
          ...realMastra,
          createDurableAgentWithSkills: async () => ({
            id: 'durable-agent-295',
            stream: async () => {
              streamCalls += 1;
              return {
                runId: 'durable-run-295',
                output: { text: Promise.resolve('done') },
                cleanup: () => undefined,
              };
            },
            getWorkspace: async () => undefined,
          }),
          clearAllHeartbeatThreads: async () => undefined,
          persistDurableRunId: async () => undefined,
          flushObservability: async () => undefined,
          getResumableDurableRun: async () => null,
        };
      }
      if (id === './wake-teardown' || id.endsWith('/wake-teardown')) {
        return { releaseWakeResources: async () => undefined };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ triggerWake } = await import('./wake-runner'));
  });

  beforeEach(() => {
    env.TOURBILLON_AGENT_TOKEN_SECRET = SECRET;
    published.length = 0;
    streamCalls = 0;
    store.agents = [{
      id: 'agent-requester', companyId: 'company-a', name: 'Cyber', urlKey: 'cyber', status: 'active',
      assignedSkills: [], adapterType: 'mastra', adapterConfig: {}, modelId: 'local/model',
      providerId: null, runtimeConfig: { timeout: { heartbeatSec: 300 } },
      budgetMonthlyTokens: 1_000_000, spentMonthlyTokens: 0,
    }];
    store.companies = [{ id: 'company-a', status: 'active', settings: {}, allowedMcpServerIds: [] }];
    store.heartbeatRuns = [];
    store.costEvents = [];
    store.activityLog = [];
    store.approvals = [];
    // Issue owned by a DIFFERENT agent — every task-scoped wake below must pre-flight-skip.
    store.issues = [{
      id: 'issue-1', companyId: 'company-a', identifier: 'TOUR-1', title: 'Ship approvals',
      status: 'todo', assigneeAgentId: 'agent-other', checkoutRunId: null, executionLockedAt: null,
      goalId: null, projectId: null,
    }];
  });

  describe('S295-S2: every task-scoped reason gates the assignee check', () => {
    it('the shared set is exactly the canonical five (membership pin)', () => {
      assert.deepEqual(
        [...TASK_SCOPED_WAKE_REASONS].sort(),
        [...CANONICAL_TASK_SCOPED].sort(),
        'dropping a member here also removes its behavioural test below — this assertion is ' +
          'what turns the drop RED instead of silently shrinking coverage',
      );
    });

    for (const reason of CANONICAL_TASK_SCOPED) {
      it(`'${reason}' wake with a mismatched assignee is SKIPPED and never starts the model`, async () => {
        assert.ok(TASK_SCOPED_WAKE_REASONS.has(reason as WakeReason), `'${reason}' must stay task-scoped`);

        const result = await triggerWake({
          agentId: 'agent-requester',
          companyId: 'company-a',
          invocationSource: reason,
          wakeReason: reason,
          taskId: 'issue-1',
        } as never);

        assert.equal(result.status, 'skipped', String(result.errorText));
        assert.match(
          result.errorText ?? '',
          /Task issue-1 is assigned to agent agent-other, not agent-requester/,
          `'${reason}' escaped the assignee-mismatch pre-flight — the model would run for a non-assignee`,
        );
        assert.equal(streamCalls, 0, `'${reason}': the model must not start for a mismatched task wake`);
        assert.equal(store.heartbeatRuns.length, 1, 'the pre-created run row is kept');
        assert.equal(store.heartbeatRuns[0]!.status, 'skipped', JSON.stringify(store.heartbeatRuns[0]));
      });
    }
  });

  describe('S295-S4: recordHeartbeatFailure never overwrites a terminal run', () => {
    // Drive the post-insert failure path (run-token mint throws with no secret configured)
    // so recordHeartbeatFailure runs against a pre-seeded terminal row.
    const failingWake = () => ({
      agentId: 'agent-requester',
      companyId: 'company-a',
      invocationSource: 'on_demand',
      wakeReason: 'on_demand',
      runId: 'run-295',
    }) as never;

    const seedRunRow = (status: string) => {
      store.heartbeatRuns = [{
        id: 'run-295', companyId: 'company-a', agentId: 'agent-requester',
        invocationSource: 'on_demand', status, startedAt: new Date(),
        lastSeenAt: null, finishedAt: null, errorText: null,
      }];
    };

    for (const status of ['succeeded', 'failed', 'cancelled', 'coalesced', 'skipped'] as const) {
      it(`a '${status}' run is NOT repainted 'failed' and publishes no red SSE update`, async () => {
        assert.ok(
          TERMINAL_HEARTBEAT_STATUSES.has(status),
          `'${status}' must stay in the shared terminal set`,
        );
        seedRunRow(status);
        delete env.TOURBILLON_AGENT_TOKEN_SECRET;

        const result = await triggerWake(failingWake());
        assert.equal(result.status, 'failed', 'the wake itself still reports the failure');
        assert.equal(result.runId, 'run-295');

        const row = store.heartbeatRuns[0]!;
        assert.equal(
          row.status,
          status,
          `recordHeartbeatFailure overwrote a terminal '${status}' run — operator kill / ` +
            `pre-flight skip / coalesce records must survive a late failure`,
        );
        assert.equal(row.errorText, null, 'the terminal record must not be rewritten');
        assert.equal(
          published.some((p) => p.message.includes('"status":"failed"')),
          false,
          `no 'failed' fan-out for an already-${status} run: ${JSON.stringify(published)}`,
        );
      });
    }

    it("a 'running' run IS still settleable to 'failed' (sweeps depend on it)", async () => {
      assert.equal(TERMINAL_HEARTBEAT_STATUSES.has('running'), false);
      seedRunRow('running');
      delete env.TOURBILLON_AGENT_TOKEN_SECRET;

      const result = await triggerWake(failingWake());
      assert.equal(result.status, 'failed');

      const row = store.heartbeatRuns[0]!;
      assert.equal(row.status, 'failed', 'a running row must be settled by the failure recorder');
      assert.ok(row.finishedAt instanceof Date);
      assert.ok(
        published.some((p) => p.message.includes('"status":"failed"')),
        'the flip must fan out over SSE',
      );
    });
  });

  describe('S299-S1: recordHeartbeatSkip never overwrites a terminal run', () => {
    // Drive the #275 assignee-mismatch pre-flight (task-scoped wake on an issue owned by
    // another agent) against a pre-seeded terminal row. recordHeartbeatSkip must be a
    // true no-op for EVERY member of the shared terminal set.
    const mismatchedWake = () => ({
      agentId: 'agent-requester',
      companyId: 'company-a',
      invocationSource: 'assignment',
      wakeReason: 'assignment',
      taskId: 'issue-1',
      runId: 'run-299',
    }) as never;

    const seedRunRow = (status: string) => {
      store.heartbeatRuns = [{
        id: 'run-299', companyId: 'company-a', agentId: 'agent-requester',
        invocationSource: 'assignment', status, startedAt: new Date(),
        lastSeenAt: null, finishedAt: null, errorText: null,
      }];
    };

    for (const status of ['succeeded', 'failed', 'cancelled', 'coalesced', 'skipped'] as const) {
      it(`a '${status}' run is NOT repainted 'skipped' and publishes no SSE update`, async () => {
        assert.ok(
          TERMINAL_HEARTBEAT_STATUSES.has(status),
          `'${status}' must stay in the shared terminal set`,
        );
        seedRunRow(status);

        const result = await triggerWake(mismatchedWake());
        assert.equal(result.status, 'skipped', 'the pre-flight still reports the skip');
        assert.equal(result.runId, 'run-299');

        const row = store.heartbeatRuns[0]!;
        assert.equal(
          row.status,
          status,
          `recordHeartbeatSkip overwrote a terminal '${status}' run — a late skip must ` +
            `never repaint an operator kill, a coalesced run, or an earlier record`,
        );
        assert.equal(row.errorText, null, 'the terminal record must not be rewritten');
        assert.equal(row.finishedAt, null, 'the terminal record must not be rewritten');
        assert.equal(
          published.some((p) => p.message.includes('"status":"skipped"')),
          false,
          `no 'skipped' fan-out for an already-${status} run: ${JSON.stringify(published)}`,
        );
      });
    }

    it("a 'queued' run IS still settled to 'skipped' (the #275 pre-flight record works)", async () => {
      seedRunRow('queued');

      const result = await triggerWake(mismatchedWake());
      assert.equal(result.status, 'skipped');

      const row = store.heartbeatRuns[0]!;
      assert.equal(row.status, 'skipped', 'a queued row must be settled by the skip recorder');
      assert.match(String(row.errorText), /assigned to agent agent-other/);
      assert.ok(row.finishedAt instanceof Date);
      assert.ok(
        published.some((p) => p.message.includes('"status":"skipped"')),
        'the flip must fan out over SSE',
      );
    });
  });
});
