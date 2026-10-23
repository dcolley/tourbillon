/**
 * UI-2: listAssistantAgents — active-company scoping, archived agents left out, status from running
 * heartbeat runs and pending approvals. @tourbillon/db and drizzle-orm are replaced by a tiny
 * in-memory store that evaluates the same conditions.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

type Row = Record<string, unknown>;
type Cond = { op: 'eq' | 'ne'; c: string; val: unknown } | { op: 'and'; xs: Cond[] };
const store: Record<string, Row[]> = {};

function table(name: string) {
  return new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => (prop === '__table' ? name : { c: prop }),
  });
}
function match(row: Row, cond: Cond): boolean {
  if (cond.op === 'and') return cond.xs.every((x) => match(row, x));
  return cond.op === 'eq' ? row[cond.c] === cond.val : row[cond.c] !== cond.val;
}
const fakeDb = {
  select: (fields: Record<string, { c: string }>) => ({
    from: (t: { __table: string }) => ({
      where: async (cond: Cond) =>
        (store[t.__table] ?? [])
          .filter((r) => match(r, cond))
          .map((r) => Object.fromEntries(Object.entries(fields).map(([k, col]) => [k, r[col.c]]))),
    }),
  }),
};

describe('UI-2 listAssistantAgents', () => {
  let listAssistantAgents: typeof import('./agents').listAssistantAgents;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      const fromLoader = this.filename?.endsWith('/lib/assistant/agents.ts');
      if (fromLoader && id === '@tourbillon/db') {
        return { db: fakeDb, agents: table('agents'), heartbeatRuns: table('heartbeatRuns'), approvals: table('approvals') };
      }
      if (fromLoader && id === 'drizzle-orm') {
        return {
          eq: (col: { c: string }, val: unknown) => ({ op: 'eq', c: col.c, val }),
          ne: (col: { c: string }, val: unknown) => ({ op: 'ne', c: col.c, val }),
          and: (...xs: Cond[]) => ({ op: 'and', xs }),
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ listAssistantAgents } = await import('./agents'));
  });

  beforeEach(() => {
    const a = (id: string, companyId: string, name: string, status = 'active', reportsToId: string | null = null) => ({
      id, companyId, name, role: 'engineer', title: 'Engineer', urlKey: id, icon: 'bot', reportsToId, status,
    });
    store.agents = [
      a('a-idle', 'co-a', 'bob'),
      a('a-run', 'co-a', 'Alice', 'active', 'a-idle'),
      a('a-wait', 'co-a', 'Carol', 'paused'),
      a('a-arch', 'co-a', 'Archie', 'archived'),
      a('b-1', 'co-b', 'Other company'),
    ];
    store.heartbeatRuns = [
      { companyId: 'co-a', agentId: 'a-run', status: 'running' },
      { companyId: 'co-a', agentId: 'a-idle', status: 'succeeded' },
      { companyId: 'co-a', agentId: 'a-wait', status: 'running' },
      { companyId: 'co-b', agentId: 'a-idle', status: 'running' },
    ];
    store.approvals = [
      { companyId: 'co-a', requestedByAgentId: 'a-wait', status: 'pending' },
      { companyId: 'co-a', requestedByAgentId: 'a-wait', status: 'pending' },
      { companyId: 'co-a', requestedByAgentId: 'a-run', status: 'approved' },
      { companyId: 'co-a', requestedByAgentId: null, status: 'pending' },
      { companyId: 'co-b', requestedByAgentId: 'a-idle', status: 'pending' },
    ];
  });

  it('returns only the company’s non-archived agents, sorted by name, with status', async () => {
    const list = await listAssistantAgents('co-a');
    assert.deepEqual(
      list.map((x) => [x.id, x.status, x.pendingApprovals, x.active]),
      [
        ['a-run', 'running', 0, true],
        ['a-idle', 'idle', 0, true],
        ['a-wait', 'waiting', 2, false],
      ],
    );
    assert.equal(list[0].reportsToId, 'a-idle');
    assert.equal(list[1].icon, 'bot');
  });

  it('another company’s runs and approvals never change status', async () => {
    const idle = (await listAssistantAgents('co-a')).find((x) => x.id === 'a-idle');
    assert.equal(idle?.status, 'idle');
    assert.deepEqual((await listAssistantAgents('co-b')).map((x) => x.id), ['b-1']);
    assert.deepEqual(await listAssistantAgents('co-none'), []);
  });
});
