/**
 * UX-2: the status chip's write (setAgentActive) changes agents.status only.
 * #119 B1: it refuses to activate an archived agent; deactivating an archived agent is a no-op.
 * The heartbeat timer (runtimeConfig.heartbeat) is a separate setting and must not be touched.
 * Real lib/agents.ts; @tourbillon/db, drizzle-orm and heavy runtime deps are mocked.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

type Row = { id: string; status: string; runtimeConfig: { heartbeat: { enabled: boolean; intervalSec: number } } };
let row: Row;
let setPayloads: Array<Record<string, unknown>>;

describe('UX-2 setAgentActive writes status only', () => {
  let setAgentActive: typeof import('./agents').setAgentActive;
  let setAgentActiveWithOutcome: typeof import('./agents').setAgentActiveWithOutcome;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      const fromAgents = this.filename?.endsWith('/lib/agents.ts');
      if (id === '@tourbillon/db' && fromAgents) {
        return {
          agents: { id: 'id' },
          companies: {},
          activityLog: {},
          db: {
            query: { agents: { findFirst: async () => ({ ...row }) } },
            update: () => ({
              set: (payload: Record<string, unknown>) => {
                setPayloads.push(payload);
                return {
                  where: () => ({
                    returning: async () => {
                      row = { ...row, ...(payload as Partial<Row>) };
                      return [{ ...row }];
                    },
                  }),
                };
              },
            }),
          },
        };
      }
      if (id === 'drizzle-orm' && fromAgents) return { eq: () => ({}), and: () => ({}) };
      if (id === '@tourbillon/mastra' && fromAgents) return { clearIdleThreadOnRuntimeSwitch: async () => {} };
      if ((id === './chat' || id === './llm-providers' || id === './company') && fromAgents) {
        return { invalidateChatControllerForAgent: () => {}, getDefaultLlmProviderRecord: async () => null, getActiveCompany: async () => ({}) };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ setAgentActive, setAgentActiveWithOutcome } = await import('./agents'));
  });

  beforeEach(() => {
    row = { id: 'agent-1', status: 'active', runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300 } } };
    setPayloads = [];
  });

  it('deactivate: sets status paused and nothing else (timer untouched)', async () => {
    const updated = await setAgentActive('agent-1', false);
    assert.equal(updated.status, 'paused');
    assert.deepEqual(Object.keys(setPayloads[0]).sort(), ['status', 'updatedAt']);
    assert.deepEqual(updated.runtimeConfig, { heartbeat: { enabled: true, intervalSec: 300 } });
  });

  it('activate a timer-off agent: status active, timer stays off', async () => {
    row = { id: 'agent-1', status: 'paused', runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0 } } };
    const updated = await setAgentActive('agent-1', true);
    assert.equal(updated.status, 'active');
    assert.deepEqual(Object.keys(setPayloads[0]).sort(), ['status', 'updatedAt']);
    assert.equal((updated.runtimeConfig as Row['runtimeConfig']).heartbeat.enabled, false);
  });
  it('#119 B1: archived → active is refused with a clear error and no write', async () => {
    row = { id: 'agent-1', status: 'archived', runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300 } } };
    await assert.rejects(() => setAgentActive('agent-1', true), {
      name: 'AgentValidationError',
      message: 'Agent is archived and cannot be activated.',
    });
    assert.deepEqual(setPayloads, []);
    assert.equal(row.status, 'archived');
  });

  it('#119 B1: deactivating an archived agent is a no-op (stays archived, no write)', async () => {
    row = { id: 'agent-1', status: 'archived', runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300 } } };
    const result = await setAgentActive('agent-1', false);
    assert.equal(result.status, 'archived');
    assert.deepEqual(setPayloads, []);
    assert.equal(row.status, 'archived');
  });

  it('#119 soft: outcome reports the archived no-op as { changed: false, reason: "archived" }', async () => {
    row = { id: 'agent-1', status: 'archived', runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300 } } };
    const outcome = await setAgentActiveWithOutcome('agent-1', false);
    assert.equal(outcome.changed, false);
    assert.equal(outcome.reason, 'archived');
    assert.equal(outcome.agent.status, 'archived');
    assert.deepEqual(setPayloads, []);
    await assert.rejects(() => setAgentActiveWithOutcome('agent-1', true), { name: 'AgentValidationError' });
  });

  it('#119 soft: outcome.changed is true for a real status change and false when already in that state', async () => {
    const off = await setAgentActiveWithOutcome('agent-1', false);
    assert.deepEqual([off.changed, off.reason, off.agent.status], [true, undefined, 'paused']);
    const again = await setAgentActiveWithOutcome('agent-1', false);
    assert.deepEqual([again.changed, again.reason, again.agent.status], [false, undefined, 'paused']);
  });

  it('pending_approval → active is still refused, no write', async () => {
    row = { id: 'agent-1', status: 'pending_approval', runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0 } } };
    await assert.rejects(() => setAgentActive('agent-1', true), { name: 'AgentValidationError' });
    assert.deepEqual(setPayloads, []);
  });
});
