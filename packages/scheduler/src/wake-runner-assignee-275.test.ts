/**
 * #275: the assignee-mismatch check in runWake applies ONLY to task-scoped wakes
 * (`assignment` / `issue_*`) and records a tripped check as `skipped`, never `failed`.
 *
 * - approval_resolved wakes carry taskId = linkedIssueIds[0] (context, not an assignment):
 *   a requester (CEO/CTO) that owns none of the linked issues must still run — the bug
 *   failed every such wake with "Task <id> is assigned to agent …, not …" before the
 *   model ran.
 * - A real task wake with a mismatched assignee is a pre-flight skip: log, wake result and
 *   heartbeat_runs row must all agree on `skipped` and the model must never start.
 *
 * @tourbillon/db, drizzle-orm, ./redis-pub, @tourbillon/mastra and ./wake-teardown are
 * swapped via Module.prototype.require (for scheduler modules only) so no database, Redis
 * or LLM is touched — same fake-DB pattern as wake-runner-teardown.test.ts (durable path:
 * the harness path's `await import('@tourbillon/db')` bypasses the require hook).
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const SECRET = 'test-agent-token-secret-275-0123456789abcdef';
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
let streamImpl: () => Promise<unknown> = async () => ({
  runId: 'durable-run-275',
  output: { text: Promise.resolve('done') },
  cleanup: () => undefined,
});

describe('#275 wake-runner assignee check (fake DB)', () => {
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
    // wake-runner reaches @tourbillon/db again via `await import()` on the durable
    // success path (detectTruncatedGeneration), which bypasses the require hook — the
    // real module loads, so neutralize its only used entry point (the db singleton is
    // the same instance every import path sees).
    const realDbModule = originalRequire.call(module, '@tourbillon/db');
    realDbModule.db.select = () => chain(() => []);
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
            id: 'durable-agent-275',
            stream: async () => {
              streamCalls += 1;
              return streamImpl();
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
    streamImpl = async () => ({
      runId: 'durable-run-275',
      output: { text: Promise.resolve('done') },
      cleanup: () => undefined,
    });
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
    // The linked/task issue is owned by a DIFFERENT agent — the #275 repro shape.
    store.issues = [{
      id: 'issue-1', companyId: 'company-a', identifier: 'TOUR-1', title: 'Ship approvals',
      status: 'todo', assigneeAgentId: 'agent-other', checkoutRunId: null, executionLockedAt: null,
      goalId: null, projectId: null,
    }];
  });

  const approvalWake = () => ({
    agentId: 'agent-requester',
    companyId: 'company-a',
    invocationSource: 'approval_resolved',
    wakeReason: 'approval_resolved',
    approvalId: 'approval-1',
    approvalStatus: 'approved',
    linkedIssueIds: ['issue-1'],
    taskId: 'issue-1',
  }) as never;

  it('requester approval_resolved wake runs when the linked issue belongs to another agent', async () => {
    const result = await triggerWake(approvalWake());

    assert.equal(result.status, 'succeeded', String(result.errorText));
    assert.equal(streamCalls, 1, 'the model must actually run for the requester');
    assert.equal(store.heartbeatRuns.length, 1);
    const row = store.heartbeatRuns[0]!;
    assert.equal(row.status, 'succeeded', JSON.stringify(row));
    assert.equal(row.errorText, null);
  });

  it('assignee approval wake is unchanged (owner of the linked issue runs)', async () => {
    store.issues[0]!.assigneeAgentId = 'agent-requester';

    const result = await triggerWake(approvalWake());

    assert.equal(result.status, 'succeeded', String(result.errorText));
    assert.equal(streamCalls, 1);
    assert.equal(store.heartbeatRuns[0]!.status, 'succeeded');
  });

  for (const reason of ['assignment', 'issue_commented'] as const) {
    it(`${reason} wake with a mismatched assignee is SKIPPED, not failed, and never starts the model`, async () => {
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
      );
      assert.equal(streamCalls, 0, 'the model must not start for a mismatched task wake');
      assert.equal(store.heartbeatRuns.length, 1, 'the pre-created run row is kept');
      const row = store.heartbeatRuns[0]!;
      assert.equal(row.status, 'skipped', JSON.stringify(row));
      assert.ok(row.finishedAt instanceof Date);
      // Log and job status agree: the SSE fan-out must also say skipped.
      const update = published.find((p) => p.message.includes('"status"'));
      assert.ok(update, 'SSE run update published');
      assert.ok(update!.message.includes('"status":"skipped"'), update!.message);
    });
  }

  it('assignment wake to the real assignee still runs', async () => {
    store.issues[0]!.assigneeAgentId = 'agent-requester';

    const result = await triggerWake({
      agentId: 'agent-requester',
      companyId: 'company-a',
      invocationSource: 'assignment',
      wakeReason: 'assignment',
      taskId: 'issue-1',
    } as never);

    assert.equal(result.status, 'succeeded', String(result.errorText));
    assert.equal(streamCalls, 1);
    assert.equal(store.heartbeatRuns[0]!.status, 'succeeded');
  });

  it('context wake that only carries a mismatched taskId (on_demand) is not assignee-checked', async () => {
    const result = await triggerWake({
      agentId: 'agent-requester',
      companyId: 'company-a',
      invocationSource: 'on_demand',
      wakeReason: 'on_demand',
      taskId: 'issue-1',
    } as never);

    assert.equal(result.status, 'succeeded', String(result.errorText));
    assert.equal(streamCalls, 1);
    assert.equal(store.heartbeatRuns[0]!.status, 'succeeded');
  });
});
