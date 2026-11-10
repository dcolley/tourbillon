/**
 * #348 C3 — Studio hydration: DB agents registered with FULL tools
 * (assembleAgentTools parity), Company-Computer tools excluded even when
 * assigned (C3e), and list == DB rows (C3a).
 *
 * buildAgent/listAgentRows/getCompany/register are injected — no DB, no
 * network. The CC filter is exercised against the REAL assembleAgentTools so
 * the mutant "drop the CC filter" turns the test red.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  dropCompanyComputerTools,
  ensureStudioAgentsHydrated,
  isCompanyComputerToolKey,
  resetStudioHydrationCache,
  studioAgentRecordForBuild,
} from './hydration';
// Relative import of the real production assembly (pattern: lib/chat/registry.ts).
import { assembleAgentTools } from '../../../../packages/mastra/src/agent-factory';

type Row = Record<string, unknown>;

function makeRow(over: Partial<Row> & { id: string }): Row {
  return {
    id: over.id,
    companyId: over.companyId ?? 'company-a',
    name: over.name ?? `Agent ${over.id}`,
    role: over.role ?? 'engineer',
    title: over.title ?? 'Engineer',
    urlKey: over.urlKey ?? over.id,
    adapterType: over.adapterType ?? 'lmstudio',
    adapterConfig: over.adapterConfig ?? {},
    modelId: over.modelId ?? 'test/model-x',
    assignedSkills: over.assignedSkills ?? ['control-plane'],
    assignedToolsets: over.assignedToolsets ?? [],
    mcpServerIds: over.mcpServerIds ?? [],
    runtimeConfig: over.runtimeConfig ?? {},
    status: over.status ?? 'active',
    instructionsBundleSoulMd: null,
    instructionsBundleAgentsMd: null,
  };
}

const ROWS: Row[] = [
  makeRow({ id: 'agent-alpha', assignedToolsets: ['comments'] }),
  makeRow({ id: 'agent-cc', companyId: 'company-b', assignedToolsets: ['comments', 'company-computer'] }),
  makeRow({ id: 'agent-beta', companyId: 'company-b' }),
];

const COMPANIES: Record<string, Row> = {
  'company-a': { id: 'company-a', allowedMcpServerIds: ['mcp-1'], settings: {} },
  'company-b': { id: 'company-b', allowedMcpServerIds: null, settings: null },
};

interface Registered {
  id: string;
  agent: unknown;
}

function makeDeps(opts?: { failFor?: Set<string> }) {
  const registered: Registered[] = [];
  const buildCalls: Array<{ record: Row; options: Record<string, unknown> }> = [];
  let listCalls = 0;
  const deps = {
    listAgentRows: async () => {
      listCalls += 1;
      return ROWS as never;
    },
    getCompany: async (companyId: string) => (COMPANIES[companyId] ?? null) as never,
    buildAgent: async (record: Row, options: Record<string, unknown>) => {
      buildCalls.push({ record, options });
      if (opts?.failFor?.has(String(record.id))) throw new Error('simulated build failure');
      // C3b fidelity: run the REAL tool assembly, then the Studio filter —
      // the registered object IS the assembled tool map for equality checks.
      const assembled = await assembleAgentTools(record as never, {
        allowedMcpServerIds: options.allowedMcpServerIds as string[],
        companySettings: options.companySettings as never,
      });
      const filter = options.toolFilter as (t: Record<string, unknown>) => Record<string, unknown>;
      return filter(assembled);
    },
    register: (agentId: string, agent: unknown) => {
      registered.push({ id: agentId, agent });
    },
  };
  return { deps, registered, buildCalls, listCalls: () => listCalls };
}

describe('#348 C3 hydration', () => {
  before(() => resetStudioHydrationCache());

  it('C3a: registered ids equal the DB rows exactly (all companies, no extras, none missing)', async () => {
    const { deps, registered, listCalls } = makeDeps();
    const result = await ensureStudioAgentsHydrated({ deps, maxAgeMs: 1 });
    resetStudioHydrationCache();
    assert.equal(listCalls(), 1);
    assert.deepEqual(
      registered.map((r) => r.id).sort(),
      ROWS.map((r) => r.id).sort(),
    );
    assert.deepEqual(result.hydrated.sort(), ROWS.map((r) => r.id).sort());
    assert.deepEqual(result.failed, []);
  });

  it('C3b: registered tools equal assembleAgentTools output (FULL tools, not placeholders) and CC-filtered', async () => {
    const { deps, registered } = makeDeps();
    await ensureStudioAgentsHydrated({ deps, maxAgeMs: 1 });
    resetStudioHydrationCache();

    // Non-CC agent: exact parity with the real assembly.
    const alpha = registered.find((r) => r.id === 'agent-alpha')!;
    const alphaFull = await assembleAgentTools(makeRow({ id: 'agent-alpha', assignedToolsets: ['comments'] }) as never, {
      allowedMcpServerIds: ['mcp-1'],
      companySettings: {} as never,
    });
    assert.deepEqual(
      Object.keys(alpha.agent as Record<string, unknown>).sort(),
      Object.keys(alphaFull).sort(),
      'Studio agent must carry the full production tool set',
    );
    assert.ok(Object.keys(alphaFull).length > 4, 'sanity: control-plane tools present');
  });

  it('C3e: CC-assigned agent lists NO CC tools; without the filter the same assembly HAS them (mutant → red)', async () => {
    const { deps, registered, buildCalls } = makeDeps();
    await ensureStudioAgentsHydrated({ deps, maxAgeMs: 1 });
    resetStudioHydrationCache();

    const ccRow = ROWS.find((r) => r.id === 'agent-cc')!;
    // Precondition: the toolset really assembles CC tools (otherwise the
    // assertion below would pass vacuously).
    const unfiltered = await assembleAgentTools(ccRow as never, {
      allowedMcpServerIds: [],
      companySettings: null as never,
    });
    const ccKeysPresent = Object.keys(unfiltered).filter(isCompanyComputerToolKey);
    assert.ok(ccKeysPresent.length >= 11, `fixture must assign real CC tools, saw ${ccKeysPresent.length}`);

    // Studio registration went through the filter: zero CC tools.
    const ccRegistered = registered.find((r) => r.id === 'agent-cc')!;
    const studioKeys = Object.keys(ccRegistered.agent as Record<string, unknown>);
    assert.deepEqual(studioKeys.filter(isCompanyComputerToolKey), [], 'CC tools leaked into Studio');
    // ...and everything else survives (full tools minus CC == non-CC assembly).
    const noCcRow = makeRow({ id: 'agent-cc', companyId: 'company-b', assignedToolsets: ['comments'] });
    const nonCcAssembly = await assembleAgentTools(noCcRow as never, {
      allowedMcpServerIds: [],
      companySettings: null as never,
    });
    assert.deepEqual(studioKeys.sort(), Object.keys(nonCcAssembly).sort());

    // Belt: the record handed to build never carries the CC toolset.
    const ccBuild = buildCalls.find((c) => c.record.id === 'agent-cc')!;
    assert.deepEqual((ccBuild.record.assignedToolsets ?? []) as string[], ['comments']);
  });

  it('build options carry the production MCP/company settings shape', async () => {
    const { deps, buildCalls } = makeDeps();
    await ensureStudioAgentsHydrated({ deps, maxAgeMs: 1 });
    resetStudioHydrationCache();
    const alpha = buildCalls.find((c) => c.record.id === 'agent-alpha')!;
    assert.deepEqual(alpha.options.allowedMcpServerIds, ['mcp-1']);
    assert.notEqual(alpha.options.companySettings, undefined, 'companySettings must be passed (parsed)');
    const beta = buildCalls.find((c) => c.record.id === 'agent-beta')!;
    assert.deepEqual(beta.options.allowedMcpServerIds, [], 'null company allowlist degrades to []');
  });

  it('C3a fallback: one broken row registers list-only (still listed), others keep full tools', async () => {
    const { deps, registered } = makeDeps({ failFor: new Set(['agent-beta']) });
    const result = await ensureStudioAgentsHydrated({ deps, maxAgeMs: 1 });
    resetStudioHydrationCache();
    assert.deepEqual(result.failed, ['agent-beta']);
    assert.deepEqual(result.hydrated.sort(), ['agent-alpha', 'agent-cc']);
    assert.deepEqual(registered.map((r) => r.id).sort(), ROWS.map((r) => r.id).sort(), 'list stays == DB rows');
    const beta = registered.find((r) => r.id === 'agent-beta')!;
    // Fallback is a Mastra Agent (listable), not a full tool build.
    const tools = (beta.agent as { tools?: Record<string, unknown> })?.tools;
    assert.ok(beta.agent, 'fallback registered');
    assert.ok(!tools || Object.keys(tools).length === 0, 'fallback must not carry tools');
  });

  it('hydration is cached per TTL; reset forces a re-read', async () => {
    const { deps, listCalls } = makeDeps();
    // NOTE: an async fn wraps its return, so compare awaited results + the
    // underlying DB-read count, not promise identity.
    const [r1, r2] = await Promise.all([
      ensureStudioAgentsHydrated({ deps, maxAgeMs: 60_000 }),
      ensureStudioAgentsHydrated({ deps, maxAgeMs: 60_000 }),
    ]);
    assert.deepEqual(r1, r2);
    assert.equal(listCalls(), 1, 'second call must not re-read the DB');
    resetStudioHydrationCache();
    await ensureStudioAgentsHydrated({ deps, maxAgeMs: 60_000 });
    assert.equal(listCalls(), 2, 'after reset, re-read');
    resetStudioHydrationCache();
  });

  it('studioAgentRecordForBuild only strips the CC toolset', () => {
    const row = makeRow({ id: 'x', assignedToolsets: ['comments', 'company-computer', 'planning'] });
    const out = studioAgentRecordForBuild(row as never);
    assert.deepEqual(out.assignedToolsets, ['comments', 'planning']);
    assert.equal((out as unknown as Row).name, row.name);
  });

  it('dropCompanyComputerTools: exact keys + computer* prefix; unrelated keys kept', () => {
    const map: Record<string, unknown> = {
      computerOpenBrowserTool: 1,
      computerNewFutureThing: 2,
      controlPlaneTool: 3,
      mcpComputerHelper: 4, // must NOT be dropped (no camel hump after computer)
      computer: 5, // bare 'computer' — not a CC tool key shape, keep
    };
    assert.deepEqual(Object.keys(dropCompanyComputerTools(map)).sort(), [
      'computer',
      'controlPlaneTool',
      'mcpComputerHelper',
    ]);
  });
});
