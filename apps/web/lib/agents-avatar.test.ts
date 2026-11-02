/**
 * AGENT-AVATAR-UI: updateAgentAvatar writes only the `avatar` member of runtimeConfig
 * (the jsonb column already exists — no migration) and preserves every other member,
 * including the heartbeat timer the scheduler reads. Real lib/agents.ts; @tourbillon/db,
 * drizzle-orm and heavy runtime deps are mocked.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

type RuntimeConfig = Record<string, unknown>;
type Row = { id: string; runtimeConfig: RuntimeConfig };
let row: Row;
let setPayloads: Array<Record<string, unknown>>;

const HEARTBEAT = { enabled: true, intervalSec: 300 };

describe('AGENT-AVATAR-UI updateAgentAvatar', () => {
  let updateAgentAvatar: typeof import('./agents').updateAgentAvatar;
  let AgentValidationError: typeof import('./agents').AgentValidationError;

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
            query: { agents: { findFirst: async () => (row ? { ...row } : null) } },
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
        return {
          invalidateChatControllerForAgent: () => {},
          getDefaultLlmProviderRecord: async () => null,
          getActiveCompany: async () => ({}),
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ updateAgentAvatar, AgentValidationError } = await import('./agents'));
  });

  beforeEach(() => {
    row = { id: 'agent-1', runtimeConfig: { heartbeat: HEARTBEAT, model: { temperature: 0.3 } } };
    setPayloads = [];
  });

  it('sets avatar and keeps every other runtimeConfig member (no migration, no clobber)', async () => {
    const updated = await updateAgentAvatar('agent-1', { shape: 'blob-2', color: '#8b5cf6' });
    assert.deepEqual(Object.keys(setPayloads[0]).sort(), ['runtimeConfig', 'updatedAt']);
    assert.deepEqual(updated.runtimeConfig, {
      heartbeat: HEARTBEAT,
      model: { temperature: 0.3 },
      avatar: { shape: 'blob-2', color: '#8b5cf6' },
    });
  });

  it('replaces a previous avatar instead of merging shapes', async () => {
    row = { id: 'agent-1', runtimeConfig: { heartbeat: HEARTBEAT, avatar: { shape: 'circle', color: '#3b82f6' } } };
    const updated = await updateAgentAvatar('agent-1', { shape: 'blob-4', color: '#f59e0b' });
    assert.deepEqual((updated.runtimeConfig as RuntimeConfig).avatar, { shape: 'blob-4', color: '#f59e0b' });
  });

  it('null clears the avatar (back to the default) and keeps the rest', async () => {
    row = { id: 'agent-1', runtimeConfig: { heartbeat: HEARTBEAT, avatar: { shape: 'circle', color: '#3b82f6' } } };
    const updated = await updateAgentAvatar('agent-1', null);
    assert.equal('avatar' in (updated.runtimeConfig as RuntimeConfig), false);
    assert.deepEqual((updated.runtimeConfig as RuntimeConfig).heartbeat, HEARTBEAT);
  });

  it('survives a null runtimeConfig column', async () => {
    row = { id: 'agent-1', runtimeConfig: null as unknown as RuntimeConfig };
    const updated = await updateAgentAvatar('agent-1', { shape: 'circle', color: '#10b981' });
    assert.deepEqual(updated.runtimeConfig, { avatar: { shape: 'circle', color: '#10b981' } });
  });

  it('unknown agent: AgentValidationError and no write', async () => {
    row = null as unknown as Row;
    await assert.rejects(() => updateAgentAvatar('missing', { shape: 'circle', color: '#3b82f6' }), {
      name: 'AgentValidationError',
    });
    assert.deepEqual(setPayloads, []);
  });
});
