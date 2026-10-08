/**
 * Board 'Archive agent' (lib/agent-archive.ts), against a tiny in-memory db.
 * Real: lib/agent-archive.ts, lib/agents.ts (#119 reactivation rule), lib/auth/agent-token-auth.ts
 * (#120/#123 archived → 401) with real signed tokens, and @tourbillon/shared's timer resolver.
 * Mocked (Module.prototype.require): @tourbillon/db, drizzle-orm, ./chat, ./wake-client and the
 * heavy imports of lib/agents.ts. The scheduler is a stub passed as deps. All values are fakes.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mintChatToken, mintRunToken, chatSessionIdForAgent } from '@tourbillon/shared/agent-token';
import { AGENT_ARCHIVED_RUN_ERROR, resolveAgentTimerSchedule } from '@tourbillon/shared';

const env = process.env as Record<string, string | undefined>;
env.TOURBILLON_AGENT_TOKEN_SECRET = 'test-agent-token-secret-archive-0123456789abcdef';

// ---- in-memory db ----------------------------------------------------------------------------
type Row = Record<string, any>;
type Cond =
  | { op: 'eq' | 'ne'; c: string; val: unknown }
  | { op: 'and' | 'or'; xs: Cond[] }
  | { op: 'in'; c: string; vals: unknown[] };
const store: Record<string, Row[]> = {};
function table(name: string) {
  return new Proxy({ __table: name } as Record<string, unknown>, {
    get: (t, prop: string) => (prop === '__table' ? name : { c: prop }),
  });
}
const nameOf = (t: unknown) => (t as { __table: string }).__table;
function match(row: Row, cond?: Cond): boolean {
  if (!cond) return true;
  switch (cond.op) {
    case 'eq': return row[cond.c] === cond.val;
    case 'ne': return row[cond.c] !== cond.val;
    case 'in': return cond.vals.includes(row[cond.c]);
    case 'and': return cond.xs.every((x) => match(row, x));
    case 'or': return cond.xs.some((x) => match(row, x));
  }
}
/** Every write, as [table, payload], to assert "no write" / write order. */
let writes: Array<[string, Row]>;
const fakeDb = {
  query: new Proxy({}, {
    get: (_t, name: string) => ({
      findFirst: async ({ where }: { where?: Cond } = {}) => {
        const row = (store[name] ?? []).find((r) => match(r, where));
        return row ? structuredClone(row) : undefined;
      },
    }),
  }),
  update: (t: unknown) => ({
    set: (v: Row) => ({
      where: (cond: Cond) => ({
        returning: async () => {
          const rows = (store[nameOf(t)] ?? []).filter((r) => match(r, cond));
          rows.forEach((r) => Object.assign(r, structuredClone(v)));
          if (rows.length) writes.push([nameOf(t), v]);
          return rows.map((r) => structuredClone(r));
        },
      }),
    }),
  }),
  insert: (t: unknown) => ({
    values: async (v: Row) => {
      (store[nameOf(t)] ??= []).push(structuredClone(v));
      writes.push([nameOf(t), v]);
    },
  }),
  select: () => ({
    from: (t: unknown) => ({
      where: async (cond: Cond) => (store[nameOf(t)] ?? []).filter((r) => match(r, cond)).map((r) => ({ ...r })),
    }),
  }),
};
let releasedLocks: string[];
let chatInvalidated: string[];

const AGENT = 'agent-a1';
const COMPANY = 'company-a';
const HEARTBEAT_ON = {
  enabled: true,
  intervalSec: 300,
  scheduleMode: 'interval',
  wakeOnAssignment: true,
  wakeOnDemand: true,
  wakeOnAutomation: false,
  maxSteps: 30,
};

function seed() {
  store.agents = [
    { id: AGENT, urlKey: 'worker', name: 'Worker', companyId: COMPANY, status: 'active', runtimeConfig: { heartbeat: { ...HEARTBEAT_ON }, timeout: { heartbeatSec: 300 } } },
    { id: 'agent-a2', urlKey: 'peer', name: 'Peer', companyId: COMPANY, status: 'active', runtimeConfig: { heartbeat: { ...HEARTBEAT_ON } } },
    { id: 'agent-b1', urlKey: 'other', name: 'Other', companyId: 'company-b', status: 'active', runtimeConfig: { heartbeat: { ...HEARTBEAT_ON } } },
  ];
  store.heartbeatRuns = [
    { id: 'run-live', agentId: AGENT, companyId: COMPANY, status: 'running', errorText: null, finishedAt: null },
    { id: 'run-done', agentId: AGENT, companyId: COMPANY, status: 'succeeded', errorText: null, finishedAt: new Date(0) },
    { id: 'run-peer', agentId: 'agent-a2', companyId: COMPANY, status: 'running', errorText: null, finishedAt: null },
    { id: 'run-other', agentId: 'agent-b1', companyId: 'company-b', status: 'running', errorText: null, finishedAt: null },
  ];
  store.activityLog = [];
}
const agentRow = (id = AGENT) => store.agents.find((a) => a.id === id)!;
const runRow = (id: string) => store.heartbeatRuns.find((r) => r.id === id)!;

type Deps = import('./agent-archive').ArchiveAgentDeps;
let killCalls: Array<{ runId: string; companyId: string; agentStatusAtKill: string }>;
let syncCalls: string[];
/** Scheduler stub: what /internal/force-kill does with reason agent_archived (row → cancelled). */
function schedulerDeps(over: Partial<Deps> = {}): Deps {
  return {
    killRun: async (runId, companyId) => {
      killCalls.push({ runId, companyId, agentStatusAtKill: agentRow().status });
      const run = store.heartbeatRuns.find((r) => r.id === runId && r.companyId === companyId);
      if (!run || !['queued', 'running'].includes(run.status)) return 'already_finished';
      Object.assign(run, { status: 'cancelled', errorText: AGENT_ARCHIVED_RUN_ERROR, finishedAt: new Date() });
      return 'aborted';
    },
    syncTimer: async (agentId) => {
      syncCalls.push(agentId);
    },
    invalidateChat: (agentId) => {
      chatInvalidated.push(agentId);
    },
    ...over,
  };
}

describe('Archive agent (lib/agent-archive)', () => {
  let archiveAgent: typeof import('./agent-archive').archiveAgent;
  let agentsLib: typeof import('./agents');
  let authenticateAgentToken: typeof import('./auth/agent-token-auth').authenticateAgentToken;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      const fromWeb = Boolean(this.filename?.includes('/apps/web/') && !this.filename.includes('/node_modules/'));
      if (fromWeb && id === '@tourbillon/db') {
        return {
          db: fakeDb,
          agents: table('agents'),
          heartbeatRuns: table('heartbeatRuns'),
          activityLog: table('activityLog'),
          companies: table('companies'),
          releaseStaleCheckoutLocksForRun: async (runId: string) => {
            releasedLocks.push(runId);
            return 1;
          },
        };
      }
      if (fromWeb && id === 'drizzle-orm') {
        return {
          eq: (col: { c: string }, val: unknown) => ({ op: 'eq', c: col.c, val }),
          ne: (col: { c: string }, val: unknown) => ({ op: 'ne', c: col.c, val }),
          inArray: (col: { c: string }, vals: unknown[]) => ({ op: 'in', c: col.c, vals }),
          and: (...xs: Cond[]) => ({ op: 'and', xs: xs.filter(Boolean) }),
          or: (...xs: Cond[]) => ({ op: 'or', xs: xs.filter(Boolean) }),
        };
      }
      if (fromWeb && id === './chat') return { invalidateChatControllerForAgent: () => {} };
      if (fromWeb && id === './wake-client') {
        return {
          requestAgentTimerScheduleSync: async () => {
            throw new Error('default deps must not be used in this test');
          },
          requestHeartbeatForceKill: async () => {
            throw new Error('default deps must not be used in this test');
          },
        };
      }
      if (fromWeb && id === '@tourbillon/mastra') return { clearIdleThreadOnRuntimeSwitch: async () => {} };
      if (fromWeb && id === './llm-providers') return { getDefaultLlmProviderRecord: async () => null };
      if (fromWeb && id === './company') return { getActiveCompany: async () => ({ id: COMPANY }) };
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ archiveAgent } = await import('./agent-archive'));
    agentsLib = await import('./agents');
    ({ authenticateAgentToken } = await import('./auth/agent-token-auth'));
  });

  beforeEach(() => {
    seed();
    writes = [];
    releasedLocks = [];
    chatInvalidated = [];
    killCalls = [];
    syncCalls = [];
  });

  it('archives: status archived, heartbeat timer off (rest of the config kept), activity row, chat dropped', async () => {
    const result = await archiveAgent(AGENT, COMPANY, schedulerDeps());
    assert.ok(result);
    assert.equal(result.changed, true);
    assert.equal(agentRow().status, 'archived');
    assert.deepEqual(agentRow().runtimeConfig.heartbeat, { ...HEARTBEAT_ON, enabled: false });
    assert.deepEqual(agentRow().runtimeConfig.timeout, { heartbeatSec: 300 });
    assert.equal(store.activityLog.length, 1);
    assert.equal(store.activityLog[0].action, 'agent.archived');
    assert.equal(store.activityLog[0].entityId, AGENT);
    assert.equal(store.activityLog[0].companyId, COMPANY);
    assert.deepEqual(store.activityLog[0].details, { previousStatus: 'active', heartbeatWasEnabled: true });
    assert.deepEqual(chatInvalidated, [AGENT]);
    // Peers untouched.
    assert.equal(agentRow('agent-a2').status, 'active');
    assert.equal(agentRow('agent-b1').status, 'active');
  });

  it('heartbeat off: the scheduler re-syncs the timer, and the timer resolver keeps an archived agent inactive', async () => {
    const result = await archiveAgent(AGENT, COMPANY, schedulerDeps());
    assert.equal(result!.timerSync, 'synced');
    assert.deepEqual(syncCalls, [AGENT]);
    const archived = agentRow();
    assert.equal(
      resolveAgentTimerSchedule({ status: archived.status, heartbeat: archived.runtimeConfig.heartbeat }).active,
      false,
    );
    // Even with a timer config left on (e.g. archived before this action existed), no timer for archived.
    assert.equal(resolveAgentTimerSchedule({ status: 'archived', heartbeat: { ...HEARTBEAT_ON } as never }).active, false);
    assert.equal(resolveAgentTimerSchedule({ status: 'active', heartbeat: { ...HEARTBEAT_ON } as never }).active, true);
    // ...and the heartbeat timer can't be turned back on.
    await assert.rejects(() => agentsLib.updateAgentRuntimeConfig(AGENT, { heartbeat: { enabled: true } }), {
      name: 'AgentValidationError',
      message: 'Agent is archived; its heartbeat timer cannot be turned on.',
    });
    assert.equal(agentRow().runtimeConfig.heartbeat.enabled, false);
  });

  it('scheduler down: still archived; timer sync deferred to the scheduler boot reconcile', async () => {
    const result = await archiveAgent(
      AGENT,
      COMPANY,
      schedulerDeps({ syncTimer: async () => { throw new Error('ECONNREFUSED'); } }),
    );
    assert.equal(result!.timerSync, 'deferred');
    assert.equal(agentRow().status, 'archived');
    assert.equal(agentRow().runtimeConfig.heartbeat.enabled, false);
  });

  it('in-flight run: archived first, then force-killed through the scheduler and recorded cancelled (agent_archived)', async () => {
    const result = await archiveAgent(AGENT, COMPANY, schedulerDeps());
    assert.deepEqual(killCalls, [{ runId: 'run-live', companyId: COMPANY, agentStatusAtKill: 'archived' }]);
    assert.deepEqual(result!.runs, [{ runId: 'run-live', outcome: 'aborted' }]);
    assert.equal(runRow('run-live').status, 'cancelled');
    assert.equal(runRow('run-live').errorText, AGENT_ARCHIVED_RUN_ERROR);
    assert.match(runRow('run-live').errorText, /agent_archived/);
    // Finished runs, a peer's run and another company's run are untouched.
    assert.equal(runRow('run-done').status, 'succeeded');
    assert.equal(runRow('run-peer').status, 'running');
    assert.equal(runRow('run-other').status, 'running');
  });

  it('in-flight run, scheduler unreachable: the run row is recorded cancelled here and its checkout locks released', async () => {
    const result = await archiveAgent(AGENT, COMPANY, schedulerDeps({ killRun: async () => 'unreachable' }));
    assert.deepEqual(result!.runs, [{ runId: 'run-live', outcome: 'recorded' }]);
    assert.equal(runRow('run-live').status, 'cancelled');
    assert.equal(runRow('run-live').errorText, AGENT_ARCHIVED_RUN_ERROR);
    assert.ok(runRow('run-live').finishedAt instanceof Date);
    assert.deepEqual(releasedLocks, ['run-live']);
    assert.equal(runRow('run-peer').status, 'running');
  });

  it('queued runs are stopped too', async () => {
    runRow('run-live').status = 'queued';
    const result = await archiveAgent(AGENT, COMPANY, schedulerDeps());
    assert.deepEqual(result!.runs, [{ runId: 'run-live', outcome: 'aborted' }]);
    assert.equal(runRow('run-live').status, 'cancelled');
  });

  it('idempotent: re-archiving is a no-op success (no agent write, no second activity row)', async () => {
    await archiveAgent(AGENT, COMPANY, schedulerDeps());
    const before = structuredClone(agentRow());
    writes = [];
    const again = await archiveAgent(AGENT, COMPANY, schedulerDeps());
    assert.ok(again);
    assert.equal(again.changed, false);
    assert.equal(again.agent.status, 'archived');
    assert.deepEqual(again.runs, []);
    assert.deepEqual(writes, []);
    assert.deepEqual(agentRow(), before);
    assert.equal(store.activityLog.length, 1);
    assert.deepEqual(chatInvalidated, [AGENT]);
  });

  it('by urlKey inside the company works; another company\'s agent (by id or urlKey) is not found, no write', async () => {
    assert.equal(await archiveAgent('agent-b1', COMPANY, schedulerDeps()), null);
    assert.equal(await archiveAgent('other', COMPANY, schedulerDeps()), null);
    assert.equal(await archiveAgent('missing', COMPANY, schedulerDeps()), null);
    assert.equal(await archiveAgent(AGENT, 'company-b', schedulerDeps()), null);
    assert.deepEqual(writes, []);
    assert.deepEqual(killCalls, []);
    assert.equal(agentRow('agent-b1').status, 'active');
    const byKey = await archiveAgent('worker', COMPANY, schedulerDeps());
    assert.equal(byKey!.agent.id, AGENT);
    assert.equal(agentRow().status, 'archived');
  });

  it('#119: reactivation is still refused after archiving (status chip, list toggle, MCP, mobile all use setAgentActive*)', async () => {
    await archiveAgent(AGENT, COMPANY, schedulerDeps());
    writes = [];
    await assert.rejects(() => agentsLib.setAgentActive(AGENT, true), {
      name: 'AgentValidationError',
      message: 'Agent is archived and cannot be activated.',
    });
    await assert.rejects(() => agentsLib.setAgentActiveWithOutcome(AGENT, true), { name: 'AgentValidationError' });
    const off = await agentsLib.setAgentActiveWithOutcome(AGENT, false);
    assert.deepEqual([off.changed, off.reason, off.agent.status], [false, 'archived', 'archived']);
    assert.deepEqual(writes, []);
    assert.equal(agentRow().status, 'archived');
  });

  it('#123: the archived agent\'s run and chat tokens are refused (401) from the moment it is archived', async () => {
    const runToken = mintRunToken({ runId: 'run-live', agentId: AGENT, companyId: COMPANY }, 600);
    const chatToken = mintChatToken({ chatSessionId: chatSessionIdForAgent(AGENT), agentId: AGENT, companyId: COMPANY });
    assert.ok(await authenticateAgentToken(runToken), 'run token valid before archive');
    assert.ok(await authenticateAgentToken(chatToken), 'chat token valid before archive');
    // Scheduler hasn't written the run row yet (still running): the archived status alone refuses.
    await archiveAgent(AGENT, COMPANY, schedulerDeps({ killRun: async () => 'already_finished' }));
    assert.equal(runRow('run-live').status, 'running');
    assert.equal(await authenticateAgentToken(runToken), null);
    assert.equal(await authenticateAgentToken(chatToken), null);
    // A peer's token is unaffected.
    const peerChat = mintChatToken({ chatSessionId: chatSessionIdForAgent('agent-a2'), agentId: 'agent-a2', companyId: COMPANY });
    assert.ok(await authenticateAgentToken(peerChat));
  });
});
