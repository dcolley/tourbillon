/**
 * S297-S3: every single-key runtimeConfig updater in lib/agents.ts must write through the
 * atomic per-key jsonb merge (`updateAgentRuntimeConfigKeys`), never a whole-document
 * read-modify-write. The pin: with a concurrent write to key B committed between the updater's
 * read and its write, key B must survive — in both directions for the pairs that race in
 * practice (avatar <-> heartbeat, avatar <-> model). The mocked db implements the two write
 * paths distinctly: `db.update().set()` replaces whatever it is handed (the old, lossy path),
 * while `updateAgentRuntimeConfigKeys` merges ops onto the LIVE row (what Postgres does with
 * `(col - 'k') || jsonb_build_object(...)` in one statement). Real packages/db semantics are
 * pinned separately against PGlite (packages/db/src/agent-runtime-config.test.ts).
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

type RuntimeConfig = Record<string, unknown>;
type Row = { id: string; companyId: string; role: string; urlKey: string; runtimeConfig: RuntimeConfig; [k: string]: unknown };
type LeafOps = { set?: Record<string, unknown>; clear?: readonly string[]; dropIfEmpty?: boolean };
type KeyOps = { set?: Record<string, unknown>; clear?: readonly string[]; merge?: Record<string, LeafOps> };

let row: Row;
let setPayloads: Array<Record<string, unknown>>;
let inserts: Array<Record<string, unknown>>;
let onRead: (() => void | Promise<void>) | null = null;
let opsLog: KeyOps[];

const AVATAR = { shape: 'blob-2', color: '#8b5cf6' };
const HEARTBEAT = { enabled: false, intervalSec: 0, scheduleMode: 'interval', wakeOnAssignment: true, wakeOnDemand: true };

function baseRow(over: Partial<Row> = {}): Row {
  return {
    id: 'agent-1',
    companyId: 'co-a',
    name: 'Writer',
    title: 'Writer',
    role: 'engineer',
    urlKey: 'writer',
    status: 'active',
    adapterType: 'lmstudio',
    adapterConfig: {},
    assignedSkills: ['control-plane'],
    assignedToolsets: [],
    mcpServerIds: [],
    budgetMonthlyTokens: 500_000,
    runtimeConfig: { heartbeat: HEARTBEAT, timeout: { heartbeatSec: 300, graceSec: 30 }, avatar: AVATAR },
    ...over,
  };
}

/** In-memory stand-in for the single-statement jsonb merge (applies to the LIVE row). */
function applyKeyOps(doc: RuntimeConfig | null, ops: KeyOps): RuntimeConfig {
  const next: RuntimeConfig = structuredClone(doc ?? {});
  for (const key of ops.clear ?? []) delete next[key];
  for (const [key, value] of Object.entries(ops.set ?? {})) {
    if (value === undefined) throw new Error(`ops mock: key "${key}" must be cleared, not set undefined`);
    next[key] = structuredClone(value);
  }
  // S306-S3: nested leaf merge onto the LIVE sub-object (what jsonb_set / `||` does in SQL).
  for (const [key, leafOps] of Object.entries(ops.merge ?? {})) {
    const liveSub = next[key];
    const sub: RuntimeConfig =
      liveSub && typeof liveSub === 'object' && !Array.isArray(liveSub) ? structuredClone(liveSub as RuntimeConfig) : {};
    for (const leaf of leafOps.clear ?? []) delete sub[leaf];
    for (const [leaf, value] of Object.entries(leafOps.set ?? {})) {
      if (value === undefined) throw new Error(`ops mock: leaf "${key}.${leaf}" must be cleared, not set undefined`);
      sub[leaf] = structuredClone(value);
    }
    if (leafOps.dropIfEmpty && Object.keys(sub).length === 0) delete next[key];
    else next[key] = sub;
  }
  return next;
}

function doc(): RuntimeConfig {
  return row.runtimeConfig as RuntimeConfig;
}

let lib: typeof import('./agents');

describe('S297-S3 atomic runtimeConfig key writes', () => {
  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    const dbMock = {
      agents: { id: 'id', companyId: 'companyId', urlKey: 'urlKey' },
      companies: { id: 'id' },
      activityLog: {},
      assertLlmProviderEnabledForCompany: async () => {},
      db: {
        query: {
          agents: {
            findFirst: async () => {
              const snapshot = row ? structuredClone(row) : null;
              if (onRead) await onRead(); // let a concurrent writer commit mid-flight
              return snapshot;
            },
          },
          companies: { findFirst: async () => ({ id: 'co-a', settings: {} }) },
        },
        update: () => ({
          set: (payload: Record<string, unknown>) => {
            // The LOSSY path: replaces the whole document it is handed. No runtimeConfig
            // updater may reach this anymore — the runtimeConfig-clobber assertions below catch
            // a regression through here.
            setPayloads.push(payload);
            return {
              where: () => ({
                returning: async () => {
                  row = { ...row, ...(payload as Partial<Row>) };
                  return [structuredClone(row)];
                },
              }),
            };
          },
        }),
        insert: () => ({
          values: async (payload: Record<string, unknown>) => {
            inserts.push(payload);
            return [payload];
          },
        }),
      },
      updateAgentRuntimeConfigKeys: async (
        _agentId: string,
        ops: KeyOps,
        extraSet: Record<string, unknown> = {},
      ) => {
        if (!row) return null;
        opsLog.push(structuredClone(ops));
        const runtimeConfig = applyKeyOps(row.runtimeConfig, ops);
        const payload = { ...structuredClone(extraSet), runtimeConfig };
        setPayloads.push(payload);
        row = { ...row, ...payload };
        return structuredClone(row);
      },
    };
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      const fromAgents = (this.filename ?? '').endsWith('/lib/agents.ts');
      if (id === '@tourbillon/db' && fromAgents) return dbMock;
      if (id === 'drizzle-orm' && fromAgents) return { eq: () => ({}), and: () => ({}) };
      if (id === '@tourbillon/mastra' && fromAgents) return { clearIdleThreadOnRuntimeSwitch: async () => {} };
      if ((id === './chat' || id === './llm-providers' || id === './company') && fromAgents) {
        return {
          invalidateChatControllerForAgent: () => {},
          getCompanyDefaultLlmProviderRecord: async () => null,
          getActiveCompany: async () => ({ id: 'co-a' }),
        };
      }
      if (id === '@tourbillon/shared/company-workspace' && fromAgents) {
        return {
          seedAgentSkillsFromTemplates: async () => {},
          buildAssignedSkills: async () => ['control-plane'],
          copyAgentWorkspaceSkills: async () => {},
          discoverCompanySkillSlugs: async () => [],
        };
      }
      if (id === '@tourbillon/shared/mcp-registry' && fromAgents) {
        return {
          resolveAgentMcpServerIds: () => [],
          listToggleableMcpServerDefinitions: () => [],
          getMcpServerDefinition: () => undefined,
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    lib = await import('./agents');
  });

  beforeEach(() => {
    row = baseRow();
    setPayloads = [];
    inserts = [];
    opsLog = [];
    onRead = null;
  });

  /** The concurrent writer used by every interleave test: someone else commits an avatar change. */
  const concurrentAvatarCommit = () => {
    onRead = async () => {
      row = { ...row, runtimeConfig: { ...doc(), avatar: { shape: 'circle', color: '#10b981' } } };
    };
  };

  it('updateAgentModelSettings writes only the `model` key and keeps a concurrently-written avatar', async () => {
    const CONCURRENT_AVATAR = { shape: 'circle', color: '#10b981' };
    onRead = async () => {
      row = { ...row, runtimeConfig: { ...doc(), avatar: CONCURRENT_AVATAR } };
    };
    const updated = await lib.updateAgentModelSettings('agent-1', { temperature: 0.7 } as never);
    onRead = null;
    const written = (setPayloads[0]!.runtimeConfig as RuntimeConfig);
    assert.deepEqual(Object.keys(setPayloads[0]!).sort(), ['runtimeConfig', 'updatedAt']);
    assert.deepEqual(written.model, { temperature: 0.7 });
    assert.deepEqual(written.avatar, CONCURRENT_AVATAR, 'concurrent avatar write survived the model write');
    assert.deepEqual((updated.runtimeConfig as RuntimeConfig).avatar, CONCURRENT_AVATAR);
  });

  it('updateAgentModelSettings with an empty patch CLEARS the model key (not whole-doc rewrite)', async () => {
    await lib.updateAgentModelSettings('agent-1', {} as never);
    assert.equal('model' in doc(), false);
    assert.deepEqual(doc().avatar, AVATAR);
    assert.deepEqual(doc().heartbeat, HEARTBEAT);
  });

  it('updateAgentRuntimeConfig({heartbeat}) keeps a concurrently-written avatar and only owns its keys', async () => {
    concurrentAvatarCommit();
    await lib.updateAgentRuntimeConfig('agent-1', { heartbeat: { enabled: false, intervalSec: 0 } });
    onRead = null;
    const written = setPayloads[0]!.runtimeConfig as RuntimeConfig;
    assert.equal((written.heartbeat as Record<string, unknown>).enabled, false);
    assert.deepEqual(written.avatar, { shape: 'circle', color: '#10b981' }, 'concurrent avatar write survived the heartbeat write');
    // `timeout` is an owned key and stays materialised (byte-identical to the old write).
    assert.deepEqual(written.timeout, { heartbeatSec: 300, graceSec: 30 });
  });

  it('updateAgentRuntimeConfig rejects an invalid heartbeat before any write', async () => {
    await assert.rejects(
      () => lib.updateAgentRuntimeConfig('agent-1', { heartbeat: { enabled: true, intervalSec: 0 } }),
      (err: Error) => err.name === 'AgentValidationError',
    );
    assert.deepEqual(setPayloads, []);
  });

  it('S306-S2: updateAgentRuntimeConfig({ mail: undefined }) CLEARS the mail key', async () => {
    // Mutant h (drop `clear.push('mail')` from the `'mail' in patch` branch) survives the rest
    // of this suite: no other test passes mail at all, and no production caller sends
    // `mail: undefined` (page.tsx always sends an object). Pin the documented contract
    // directly: an explicit `mail: undefined` must reach the atomic writer as a CLEAR.
    row = { ...row, runtimeConfig: { ...doc(), mail: { enabled: true } } };

    const updated = await lib.updateAgentRuntimeConfig('agent-1', { mail: undefined });

    assert.equal('mail' in doc(), false, 'mail key removed from the stored document');
    assert.equal('mail' in (updated.runtimeConfig as RuntimeConfig), false, 'returned row reflects the clear');
    assert.equal(setPayloads.length, 1, 'exactly one atomic write');
    const written = setPayloads[0]!.runtimeConfig as RuntimeConfig;
    assert.equal('mail' in written, false, 'ops carried a clear, not a set');
    assert.deepEqual(written.timeout, { heartbeatSec: 300, graceSec: 30 }, 'owned timeout still materialised');
    assert.deepEqual(written.avatar, AVATAR, 'untouched keys survive');

    // Control for the same branch: a provided mail value still SETS.
    await lib.updateAgentRuntimeConfig('agent-1', { mail: { enabled: true } });
    assert.deepEqual(doc().mail, { enabled: true });
  });

  it('updateAgentBudget writes budget + the column, keeping avatar/heartbeat', async () => {
    concurrentAvatarCommit();
    await lib.updateAgentBudget('agent-1', { budgetMonthlyTokens: 1234, enforce: true });
    onRead = null;
    const payload = setPayloads[0]!;
    assert.equal(payload.budgetMonthlyTokens, 1234);
    const written = payload.runtimeConfig as RuntimeConfig;
    assert.equal((written.budget as Record<string, unknown>).enforce, true);
    assert.deepEqual(written.avatar, { shape: 'circle', color: '#10b981' }, 'concurrent avatar write survived the budget write');
    assert.deepEqual(doc().heartbeat, HEARTBEAT);
  });

  it('updateAgentObservationalMemory writes only the observationalMemory key', async () => {
    await lib.updateAgentObservationalMemory('agent-1', { mode: 'off' });
    const written = setPayloads[0]!.runtimeConfig as RuntimeConfig;
    assert.deepEqual(Object.keys(setPayloads[0]!).sort(), ['runtimeConfig', 'updatedAt']);
    assert.deepEqual(written.observationalMemory, { mode: 'off' });
    assert.deepEqual(written.avatar, AVATAR);
    assert.deepEqual(written.heartbeat, HEARTBEAT);
  });

  it('updateAgentSecrets merges onto the live row: secrets set, other keys (even concurrent ones) intact', async () => {
    const CONCURRENT_AVATAR = { shape: 'hex', color: '#ef4444' };
    onRead = async () => {
      row = { ...row, runtimeConfig: { ...doc(), avatar: CONCURRENT_AVATAR } };
    };
    await lib.updateAgentSecrets('agent-1', { secrets: { API_KEY: 'abc' } });
    onRead = null;
    const written = setPayloads[0]!.runtimeConfig as RuntimeConfig;
    assert.deepEqual(Object.keys(setPayloads[0]!).sort(), ['runtimeConfig', 'updatedAt']);
    assert.deepEqual(written.secrets, { API_KEY: 'abc' });
    assert.deepEqual(written.avatar, CONCURRENT_AVATAR, 'concurrent avatar write survived the secrets write');
    assert.deepEqual(written.heartbeat, HEARTBEAT);
  });

  it('updateAgentSecrets clearing the last secret REMOVES the key (no `secrets: undefined`)', async () => {
    row = { ...row, runtimeConfig: { ...doc(), secrets: { A: 'x' } } };
    await lib.updateAgentSecrets('agent-1', { secrets: {}, replace: true });
    assert.equal('secrets' in doc(), false);
    assert.deepEqual(doc().avatar, AVATAR);
  });

  it('deleteAgentSecrets drops only the named secret keys', async () => {
    row = { ...row, runtimeConfig: { ...doc(), secrets: { A: 'x', B: 'y' } } };
    await lib.deleteAgentSecrets('agent-1', ['A']);
    assert.deepEqual(doc().secrets, { B: 'y' });
    assert.deepEqual(doc().avatar, AVATAR);
    await lib.deleteAgentSecrets('agent-1', ['B']);
    assert.equal('secrets' in doc(), false, 'last secret removed clears the key');
  });

  it('updateAgentRole rewrites assignedTools + role columns but never touches avatar/heartbeat', async () => {
    concurrentAvatarCommit();
    await lib.updateAgentRole('agent-1', 'pm');
    onRead = null;
    const payload = setPayloads[0]!;
    assert.equal(payload.role, 'pm');
    const written = payload.runtimeConfig as RuntimeConfig;
    assert.ok(Array.isArray(written.assignedTools));
    assert.deepEqual(written.avatar, { shape: 'circle', color: '#10b981' }, 'concurrent avatar write survived the role change');
    assert.deepEqual(doc().heartbeat, HEARTBEAT);
  });

  it('updateAgentCodeExecution writes only the codeExecution key plus its columns', async () => {
    concurrentAvatarCommit();
    await lib.updateAgentCodeExecution('agent-1', {
      runtimeType: 'agent',
      codeExecutionEnabled: true,
      timeoutMs: 5_000,
    });
    onRead = null;
    const payload = setPayloads[0]!;
    assert.deepEqual(payload.assignedToolsets, ['code-execution']);
    const written = payload.runtimeConfig as RuntimeConfig;
    assert.deepEqual(written.codeExecution, { timeoutMs: 5_000 });
    assert.deepEqual(written.avatar, { shape: 'circle', color: '#10b981' }, 'concurrent avatar write survived the code-execution save');
    assert.deepEqual(doc().heartbeat, HEARTBEAT);
    assert.equal(inserts.length, 1, 'activity log written');
  });

  it('updateAgentCodeExecution with clearCodeExecutionOverrides REMOVES the codeExecution key', async () => {
    row = { ...row, runtimeConfig: { ...doc(), codeExecution: { timeoutMs: 1 } } };
    await lib.updateAgentCodeExecution('agent-1', {
      runtimeType: 'agent',
      codeExecutionEnabled: false,
      clearCodeExecutionOverrides: true,
    });
    assert.equal('codeExecution' in doc(), false);
    assert.deepEqual(doc().avatar, AVATAR);
  });

  it('updateAgentCapabilities owns only its keys: clears a stale integration key, keeps avatar/heartbeat', async () => {
    row = { ...row, runtimeConfig: { ...doc(), tavilyApiKey: 'old-key' } };
    concurrentAvatarCommit();
    await lib.updateAgentCapabilities('agent-1', {
      toolsets: ['comments'],
      assignedTools: ['createIssue'],
      assignedSkills: ['control-plane'],
      clearIntegrations: ['tavilyApiKey'],
    });
    onRead = null;
    const written = setPayloads[0]!.runtimeConfig as RuntimeConfig;
    assert.equal('tavilyApiKey' in written, false, 'cleared integration key is gone');
    assert.deepEqual(written.assignedTools, ['createIssue']);
    assert.deepEqual(written.avatar, { shape: 'circle', color: '#10b981' }, 'concurrent avatar write survived the capabilities save');
    assert.deepEqual(doc().heartbeat, HEARTBEAT, 'heartbeat (another owner) was never rewritten');
  });
  // ── S306-S3: nested leaf merges ────────────────────────────────────────────────────────────
  // Each test commits a concurrent edit to a DIFFERENT LEAF of the same key between the
  // updater's read and its write. A whole-key overwrite (`set: { key: snapshotMerged }`) drops
  // that leaf; the nested merge keeps it.

  /** Commits `leaves` into `runtimeConfig[key]` on the live row, mid-flight. */
  const concurrentLeafCommit = (key: string, leaves: Record<string, unknown>) => {
    onRead = async () => {
      const sub = (doc()[key] as RuntimeConfig | undefined) ?? {};
      row = { ...row, runtimeConfig: { ...doc(), [key]: { ...sub, ...leaves } } };
    };
  };

  it('S306-S3: updateAgentSecrets (merge) keeps a concurrently-added secret leaf', async () => {
    row = { ...row, runtimeConfig: { ...doc(), secrets: { OLD: 'o' } } };
    concurrentLeafCommit('secrets', { OTHER: 'concurrent' });
    await lib.updateAgentSecrets('agent-1', { secrets: { API_KEY: 'abc' } });
    onRead = null;
    assert.deepEqual(doc().secrets, { OLD: 'o', OTHER: 'concurrent', API_KEY: 'abc' }, 'both secret writes survive');
    assert.equal(opsLog.length, 1);
    assert.equal(opsLog[0]!.set?.secrets, undefined, 'no whole-key secrets overwrite');
    assert.deepEqual(opsLog[0]!.merge?.secrets?.set, { API_KEY: 'abc' }, 'only the changed leaf is written');
  });

  it('S306-S3: updateAgentSecrets (merge) emptying a value clears only that leaf; replace stays whole-key', async () => {
    row = { ...row, runtimeConfig: { ...doc(), secrets: { A: 'x', B: 'y' } } };
    concurrentLeafCommit('secrets', { C: 'concurrent' });
    await lib.updateAgentSecrets('agent-1', { secrets: { A: '  ' } });
    onRead = null;
    assert.deepEqual(doc().secrets, { B: 'y', C: 'concurrent' });
    assert.deepEqual(opsLog[0]!.merge?.secrets?.clear, ['A']);

    // replace: true keeps its documented whole-key semantics (the caller asked for exactly this set).
    await lib.updateAgentSecrets('agent-1', { secrets: { Z: 'z' }, replace: true });
    assert.deepEqual(doc().secrets, { Z: 'z' });
    assert.deepEqual(opsLog[1]!.set, { secrets: { Z: 'z' } });
  });

  it('S306-S3: deleteAgentSecrets removes only the named leaves and keeps a concurrently-added one', async () => {
    row = { ...row, runtimeConfig: { ...doc(), secrets: { A: 'x', B: 'y' } } };
    concurrentLeafCommit('secrets', { C: 'concurrent' });
    await lib.deleteAgentSecrets('agent-1', ['A', 'B']);
    onRead = null;
    assert.deepEqual(doc().secrets, { C: 'concurrent' }, 'concurrent secret survived; key not dropped while non-empty');
    assert.deepEqual(opsLog[0]!.merge?.secrets, { clear: ['A', 'B'], dropIfEmpty: true });
  });

  it('S306-S3: updateAgentModelSettings writes only the changed model leaf (concurrent topP survives)', async () => {
    row = { ...row, runtimeConfig: { ...doc(), model: { temperature: 0.2, maxOutputTokens: 4096 } } };
    concurrentLeafCommit('model', { topP: 0.9 });
    await lib.updateAgentModelSettings('agent-1', { temperature: 0.7 } as never);
    onRead = null;
    assert.deepEqual(doc().model, { temperature: 0.7, maxOutputTokens: 4096, topP: 0.9 });
    assert.deepEqual(opsLog[0]!.merge?.model, { set: { temperature: 0.7 }, dropIfEmpty: true });

    // Clearing a leaf removes only that leaf; the key stays while the LIVE value is non-empty.
    await lib.updateAgentModelSettings('agent-1', { temperature: null } as never);
    assert.deepEqual(doc().model, { maxOutputTokens: 4096, topP: 0.9 });
  });

  it('S306-S3: updateAgentBudget merges only budget.enforce (a concurrent budget leaf survives)', async () => {
    row = { ...row, runtimeConfig: { ...doc(), budget: { enforce: false } } };
    concurrentLeafCommit('budget', { alertAtPercent: 80 });
    await lib.updateAgentBudget('agent-1', { budgetMonthlyTokens: 99, enforce: true });
    onRead = null;
    assert.deepEqual(doc().budget, { enforce: true, alertAtPercent: 80 });
    assert.equal(opsLog[0]!.set?.budget, undefined, 'no whole-key budget overwrite');
  });

  it('S306-S3: updateAgentRuntimeConfig({heartbeat}) merges leaves (concurrent maxSteps survives)', async () => {
    concurrentLeafCommit('heartbeat', { maxSteps: 12 });
    await lib.updateAgentRuntimeConfig('agent-1', { heartbeat: { wakeOnDemand: false } });
    onRead = null;
    const hb = doc().heartbeat as RuntimeConfig;
    assert.equal(hb.wakeOnDemand, false, 'own leaf written');
    assert.equal(hb.maxSteps, 12, 'concurrent heartbeat leaf survived');
    assert.equal(hb.wakeOnAssignment, true, 'untouched leaf kept');
    assert.equal(opsLog[0]!.set?.heartbeat, undefined, 'no whole-key heartbeat overwrite');
    assert.deepEqual(opsLog[0]!.merge?.heartbeat?.set, { wakeOnDemand: false });
  });

  it('S306-S3: heartbeat normalisation clears dropped leaves (cron → interval drops cronExpression/timezone)', async () => {
    row = {
      ...row,
      runtimeConfig: {
        ...doc(),
        heartbeat: { ...HEARTBEAT, enabled: true, scheduleMode: 'cron', cronExpression: '0 * * * *', timezone: 'UTC' },
      },
    };
    concurrentLeafCommit('heartbeat', { maxSteps: 7 });
    await lib.updateAgentRuntimeConfig('agent-1', {
      heartbeat: { scheduleMode: 'interval', intervalSec: 600, enabled: true },
    });
    onRead = null;
    const hb = doc().heartbeat as RuntimeConfig;
    assert.equal(hb.scheduleMode, 'interval');
    assert.equal(hb.intervalSec, 600);
    assert.equal('cronExpression' in hb, false);
    assert.equal('timezone' in hb, false);
    assert.equal(hb.maxSteps, 7, 'concurrent leaf survived the mode switch');
  });

  it('S306-S3: updateAgentRuntimeConfig({timeout}) merges leaves (concurrent graceSec survives)', async () => {
    concurrentLeafCommit('timeout', { graceSec: 45 });
    await lib.updateAgentRuntimeConfig('agent-1', { timeout: { heartbeatSec: 900 } });
    onRead = null;
    assert.deepEqual(doc().timeout, { heartbeatSec: 900, graceSec: 45 });
    assert.equal(opsLog[0]!.set?.timeout, undefined, 'no whole-key timeout overwrite');
  });
});
