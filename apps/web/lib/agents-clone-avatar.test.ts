/**
 * S297-S4: cloneAgent copy semantics for `runtimeConfig.avatar`. Decision: a clone INHERITS the
 * source's avatar — structuredClone copies the whole runtimeConfig, heartbeat is the only
 * override (disabled), integration secrets are stripped only with copyCredentials=false.
 * This test pins that explicit choice (see the S297-S4 comment in lib/agents.ts): if someone
 * later decides clones should start with the default avatar, this suite goes RED on purpose.
 * Real lib/agents.ts; @tourbillon/db and workspace-skills side effects are mocked.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

type RuntimeConfig = Record<string, unknown>;
type Cond = { col: string; val: unknown } | { and: Cond[] };
type Row = Record<string, unknown> & { id: string; companyId: string; urlKey: string };

let rows: Row[];
let inserts: Array<Record<string, unknown>>;

function flatten(c: Cond | undefined): Array<{ col: string; val: unknown }> {
  if (!c) return [];
  return 'and' in c ? c.and.flatMap(flatten) : [c];
}

const AVATAR = { shape: 'blob-4', color: '#f59e0b' };

function sourceAgent(over: Partial<Row> = {}): Row {
  return {
    id: 'agent-src',
    companyId: 'co-a',
    name: 'Writer',
    title: 'Writer',
    role: 'engineer',
    icon: 'bot',
    urlKey: 'writer',
    providerId: 'p-on',
    modelId: 'm-1',
    adapterType: 'lmstudio',
    adapterConfig: {},
    assignedSkills: ['control-plane'],
    assignedToolsets: ['comments'],
    mcpServerIds: [],
    budgetMonthlyTokens: 500_000,
    spentMonthlyTokens: 4321,
    status: 'active',
    runtimeConfig: {
      heartbeat: { enabled: true, intervalSec: 300, scheduleMode: 'interval', wakeOnAssignment: true, wakeOnDemand: true },
      timeout: { heartbeatSec: 300, graceSec: 30 },
      avatar: { ...AVATAR },
      tavilyApiKey: 'tv-key',
      mcpCredentials: { 'buffer-mcp': 'buf' },
      secrets: { TOP_SECRET: 'shh' },
    },
    ...over,
  };
}

let cloneAgent: typeof import('./agents').cloneAgent;

describe('S297-S4 cloneAgent inherits the source avatar (copy semantics)', () => {
  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    const dbMock = {
      agents: { id: 'id', companyId: 'companyId', urlKey: 'urlKey' },
      companies: {},
      activityLog: {},
      assertLlmProviderEnabledForCompany: async () => {},
      db: {
        query: {
          agents: {
            findFirst: async ({ where }: { where?: Cond }) => {
              const conds = flatten(where);
              return rows.find((r) => conds.every((c) => r[c.col] === c.val)) ?? null;
            },
          },
        },
        insert: () => ({
          values: (payload: Record<string, unknown>) => {
            inserts.push(payload);
            return { returning: async () => [{ id: 'agent-new', ...structuredClone(payload) }] };
          },
        }),
      },
    };
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      const fromAgents = (this.filename ?? '').endsWith('/lib/agents.ts');
      if (id === '@tourbillon/db' && fromAgents) return dbMock;
      if (id === 'drizzle-orm' && fromAgents) {
        return { eq: (col: string, val: unknown) => ({ col, val }), and: (...conds: Cond[]) => ({ and: conds }) };
      }
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
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ cloneAgent } = await import('./agents'));
  });

  beforeEach(() => {
    rows = [sourceAgent()];
    inserts = [];
  });

  const clone = (copyCredentials?: boolean) =>
    cloneAgent({
      sourceAgentId: 'agent-src',
      name: 'Writer copy',
      urlKey: 'writer-copy',
      ...(copyCredentials === undefined ? {} : { copyCredentials }),
    });

  it('the clone starts with the SOURCE avatar (explicit copy-semantics decision)', async () => {
    const created = await clone();
    assert.equal(inserts.length, 1);
    const runtime = created.runtimeConfig as RuntimeConfig;
    assert.deepEqual(runtime.avatar, AVATAR, 'clone inherits the source avatar');
    // The avatar rides along with every other runtimeConfig member…
    assert.deepEqual(runtime.timeout, { heartbeatSec: 300, graceSec: 30 });
    assert.deepEqual(runtime.secrets, { TOP_SECRET: 'shh' });
    // …while heartbeat is the single deliberate override (disabled on clones).
    assert.equal((runtime.heartbeat as RuntimeConfig).enabled, false);
    assert.equal(created.spentMonthlyTokens, 0);
  });

  it('copyCredentials=false strips integration secrets but STILL copies the avatar', async () => {
    const created = await clone(false);
    const runtime = created.runtimeConfig as RuntimeConfig;
    assert.equal('tavilyApiKey' in runtime, false);
    assert.equal('mcpCredentials' in runtime, false);
    assert.deepEqual(runtime.avatar, AVATAR, 'avatar is config, not a credential — always copied');
  });

  it('the copied avatar is a deep copy (mutating the clone config cannot alias the source row)', async () => {
    const source = rows[0]!;
    const created = await clone();
    const runtime = created.runtimeConfig as RuntimeConfig;
    assert.notEqual(runtime.avatar, (source.runtimeConfig as RuntimeConfig).avatar, 'not the same object reference');
    (runtime.avatar as RuntimeConfig).color = '#000000';
    assert.deepEqual((source.runtimeConfig as RuntimeConfig).avatar, AVATAR, 'source row untouched');
  });
});
