/**
 * AGENT-AVATAR-UI: updateAgentAvatar writes only the `avatar` member of runtimeConfig
 * (the jsonb column already exists — no migration) and preserves every other member,
 * including the heartbeat timer the scheduler reads. S297-S3 additionally pins that the write
 * is an atomic per-key jsonb merge (via updateAgentRuntimeConfigKeys), never a whole-document
 * rewrite from the function's own (possibly stale) read. Real lib/agents.ts; @tourbillon/db,
 * drizzle-orm and heavy runtime deps are mocked. The mock's `updateAgentRuntimeConfigKeys`
 * applies the ops to the LIVE row — the same semantics Postgres gives `(col - k) || object`.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

type RuntimeConfig = Record<string, unknown>;
type Row = { id: string; runtimeConfig: RuntimeConfig };
type KeyOps = { set?: Record<string, unknown>; clear?: readonly string[] };
let row: Row;
let setPayloads: Array<Record<string, unknown>>;
/** Hook fired inside the mocked findFirst AFTER the row snapshot was taken (race simulation). */
let onRead: (() => void | Promise<void>) | null = null;

const HEARTBEAT = { enabled: true, intervalSec: 300 };

/** Faithful in-memory stand-in for the jsonb merge of packages/db updateAgentRuntimeConfigKeys. */
function applyKeyOps(doc: RuntimeConfig | null, ops: KeyOps): RuntimeConfig {
  const next: RuntimeConfig = { ...(doc ?? {}) };
  for (const key of ops.clear ?? []) delete next[key];
  for (const [key, value] of Object.entries(ops.set ?? {})) {
    if (value === undefined) throw new Error(`ops mock: key "${key}" must be cleared, not set undefined`);
    next[key] = structuredClone(value);
  }
  return next;
}

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
            query: {
              agents: {
                findFirst: async () => {
                  const snapshot = row ? structuredClone(row) : null;
                  if (onRead) await onRead(); // let a concurrent writer commit mid-flight
                  return snapshot;
                },
              },
            },
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
          // S297-S3: the atomic single-statement jsonb update. Ops apply to the LIVE row, so a
          // key written concurrently (after our caller's read) survives — unlike `db.update`
          // above, which replaces whatever it is handed wholesale.
          updateAgentRuntimeConfigKeys: async (
            _agentId: string,
            ops: KeyOps,
            extraSet: Record<string, unknown> = {},
          ) => {
            if (!row) return null;
            const runtimeConfig = applyKeyOps(row.runtimeConfig, ops);
            const payload = { ...structuredClone(extraSet), runtimeConfig };
            setPayloads.push(payload);
            row = { ...row, ...payload };
            return structuredClone(row);
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
    onRead = null;
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

  it('S297-S3: updating the avatar never drops a concurrently-written key (simulated interleave)', async () => {
    // The avatar save reads the row; before it can write, another updater (here: a heartbeat
    // save) COMMITS a change to a different key. With the pre-S297-S3 whole-object rewrite the
    // avatar write would persist its stale snapshot and silently revert the heartbeat; the
    // atomic per-key merge must keep BOTH: avatar set, concurrent heartbeat intact.
    const CONCURRENT_HEARTBEAT = {
      enabled: false,
      intervalSec: 0,
      scheduleMode: 'interval',
      wakeOnAssignment: true,
      wakeOnDemand: true,
    };
    onRead = async () => {
      row = { ...row, runtimeConfig: { ...row.runtimeConfig, heartbeat: CONCURRENT_HEARTBEAT } };
    };

    const updated = await updateAgentAvatar('agent-1', { shape: 'blob-2', color: '#8b5cf6' });
    onRead = null;

    const doc = updated.runtimeConfig as RuntimeConfig;
    assert.deepEqual(doc.avatar, { shape: 'blob-2', color: '#8b5cf6' }, 'avatar landed');
    assert.deepEqual(doc.heartbeat, CONCURRENT_HEARTBEAT, 'concurrent heartbeat write survived');
    assert.deepEqual(doc.model, { temperature: 0.3 });
    assert.equal(setPayloads.length, 1);
    // The write touched ONLY the avatar key: the payload's runtimeConfig was merged onto the
    // live row (heartbeat present), not rebuilt from the stale read.
    assert.notEqual((setPayloads[0]!.runtimeConfig as RuntimeConfig).heartbeat, HEARTBEAT);
  });
});
