/**
 * UX-2: the status chip's write (setAgentActive) changes agents.status only.
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
    ({ setAgentActive } = await import('./agents'));
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
});
