/**
 * Live tool permission gate: end-to-end through the real agent builders (heartbeat durable agent,
 * harness controller backing agent, dashboard chat agent) with a scripted mock model, in-memory
 * agent/company rows and in-memory Mastra storage. No database, network or model provider.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { performance } from 'node:perf_hooks';
import { Mastra } from '@mastra/core';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { RequestContext } from '@mastra/core/request-context';
import { Memory } from '@mastra/memory';
import { z } from 'zod';
import type { Agent as AgentRecord } from '@tourbillon/db';

// Module-level DB clients are created lazily and never connected in this file.
process.env.DATABASE_URL ??= 'postgres://tool-gate-test:unused@127.0.0.1:1/unused';

// Workspace sources under packages/shared import @tourbillon/db, which is linked into this
// package's node_modules but not into packages/shared's. Let the loader find it from here.
{
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeModule = require('node:module') as { _initPaths?: () => void };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('node:path') as typeof import('node:path');
  const local = nodePath.resolve(__dirname, '..', 'node_modules');
  process.env.NODE_PATH = [local, process.env.NODE_PATH].filter(Boolean).join(nodePath.delimiter);
  nodeModule._initPaths?.();
}

type Gate = typeof import('./tool-gate');
type Factory = typeof import('./agent-factory');
type Controller = typeof import('./controller-config');
type Chat = typeof import('./chat-controller');
type McpTools = typeof import('./tools/mcp-tools');
type ApiClient = typeof import('./tools/api-client');
type Shared = typeof import('@tourbillon/shared');

let gate: Gate;
let factory: Factory;
let controller: Controller;
let chat: Chat;
let mcp: McpTools;
let api: ApiClient;
let shared: Shared;

type AgentRow = AgentRecord;
type CompanyRow = { id: string; status: 'active' | 'paused' | 'archived'; settings: Record<string, unknown>; allowedMcpServerIds: string[]; updatedAt: Date };

const agentRows = new Map<string, AgentRow>();
const companyRows = new Map<string, CompanyRow>();
const deniedRows: Array<Record<string, unknown>> = [];
const gateWarnings: string[] = [];
const fetchCalls: string[] = [];
const mcpCalls: string[] = [];
const unlistedCalls: string[] = [];
let clock = 1_700_000_000_000;
let loadAgentOverride: ((id: string) => Promise<unknown>) | null = null;

const COMPANY_A = 'company-a-5c1f';
const COMPANY_B = 'company-b-93d0';
const SEARCH_ENV = ['SEARXNG_URL', 'SEARXNG_API_KEY', 'TAVILY_API_KEY', 'NITTER_URL', 'BUFFER_MCP_URL', 'OBSERVABILITY_ENABLED', 'PHOENIX_COLLECTOR_ENABLED'];
const savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

function makeAgent(id: string, companyId: string, over: Partial<AgentRow> = {}): AgentRow {
  const now = new Date(clock);
  const row = {
    id,
    companyId,
    name: `Agent ${id}`,
    role: 'engineer',
    title: 'Engineer',
    icon: 'bot',
    urlKey: id,
    reportsToId: null,
    adapterType: 'lmstudio',
    adapterConfig: {},
    providerId: null,
    modelId: 'mock-model',
    instructionsBundleSoulMd: null,
    instructionsBundleAgentsMd: null,
    instructionsPath: null,
    assignedSkills: ['control-plane'],
    assignedToolsets: [],
    mcpServerIds: [],
    budgetMonthlyTokens: 500_000,
    spentMonthlyTokens: 0,
    status: 'active',
    runtimeConfig: {},
    defaultBillingCode: 'default',
    createdAt: now,
    updatedAt: now,
    ...over,
  } as AgentRow;
  agentRows.set(id, row);
  return row;
}

function makeCompany(id: string, over: Partial<CompanyRow> = {}): CompanyRow {
  const row: CompanyRow = { id, status: 'active', settings: {}, allowedMcpServerIds: [], updatedAt: new Date(clock), ...over };
  companyRows.set(id, row);
  return row;
}

/** Change a row the way a dashboard edit would, then let the gate cache expire. */
function editAgent(id: string, patch: Partial<AgentRow>): void {
  const row = agentRows.get(id)!;
  agentRows.set(id, { ...row, ...patch, updatedAt: new Date(clock + 1) } as AgentRow);
  clock += gate.TOOL_GATE_CACHE_TTL_MS;
}

function editCompany(id: string, patch: Partial<CompanyRow>): void {
  const row = companyRows.get(id)!;
  companyRows.set(id, { ...row, ...patch, updatedAt: new Date(clock + 1) });
  clock += gate.TOOL_GATE_CACHE_TTL_MS;
}

function contextFor(agent: { id: string; companyId: string }, runId = `run-${agent.id}`) {
  return api.createHeartbeatRuntimeContext({
    apiKey: 'test-run-token',
    runId,
    agentId: agent.id,
    companyId: agent.companyId,
  });
}

interface ScriptedModel {
  prompts: unknown[];
  model: unknown;
}

/** Each entry is one model step: tool names to call, or a final text answer when exhausted. */
function scriptedModel(steps: string[][], onCall?: (n: number) => void | Promise<void>): ScriptedModel {
  const prompts: unknown[] = [];
  let call = 0;
  const finish = (unified: string, raw: string) => ({
    type: 'finish',
    finishReason: { unified, raw },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
  });
  const model = {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('doGenerate not used');
    },
    doStream: async (options: { prompt: unknown }) => {
      call += 1;
      prompts.push(options.prompt);
      await onCall?.(call);
      const names = steps[call - 1];
      const chunks: unknown[] = names
        ? [
            { type: 'stream-start', warnings: [] },
            ...names.map((toolName, i) => ({ type: 'tool-call', toolCallId: `call-${call}-${i}`, toolName, input: '{}' })),
            finish('tool-calls', 'tool_calls'),
          ]
        : [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'done' },
            { type: 'text-end', id: 't' },
            finish('stop', 'stop'),
          ];
      return {
        stream: new ReadableStream({
          start(c) {
            for (const chunk of chunks) c.enqueue(chunk);
            c.close();
          },
        }),
      };
    },
  };
  return { prompts, model };
}

interface ToolOutcome {
  name: string;
  result?: any;
  error?: string;
}

async function runAgent(
  agentLike: any,
  model: ScriptedModel,
  requestContext: unknown,
  extra: Record<string, unknown> = {},
): Promise<{ outcomes: ToolOutcome[]; text: string }> {
  agentLike.__updateModel({ model: model.model });
  const res = await agentLike.stream('go', { maxSteps: 6, requestContext, ...extra });
  const outcomes: ToolOutcome[] = [];
  let text = '';
  for await (const chunk of res.fullStream as AsyncIterable<any>) {
    if (chunk.type === 'tool-result') outcomes.push({ name: chunk.payload.toolName, result: chunk.payload.result });
    else if (chunk.type === 'tool-error') {
      outcomes.push({ name: chunk.payload.toolName, error: chunk.payload.error?.name ?? String(chunk.payload.error) });
    } else if (chunk.type === 'text-delta') text += chunk.payload.text;
  }
  return { outcomes, text };
}

function deniedOutcome(outcome: ToolOutcome | undefined, reason?: string): void {
  assert.ok(outcome, 'tool outcome present');
  assert.equal(outcome.result?.error, 'tool_not_allowed', `expected tool_not_allowed, got ${JSON.stringify(outcome)}`);
  if (reason) assert.equal(outcome.result?.reason, reason);
}

function fakeMcpTool(id: string) {
  return createTool({
    id,
    description: `fake ${id}`,
    inputSchema: z.object({}),
    execute: async () => {
      mcpCalls.push(id);
      return { ok: true, tool: id };
    },
  });
}

/** Serve fake filesystem MCP tools for a company (real assembly / filter path, no server). */
function primeFilesystemMcp(companyId: string): void {
  mcp.primeMcpClientCacheForTests(mcp.mcpClientCacheKey({ serverId: 'filesystem-local', companyId }), {
    listTools: async () => ({
      filesystem_read_file: fakeMcpTool('filesystem_read_file'),
      filesystem_write_file: fakeMcpTool('filesystem_write_file'),
    }),
  });
}

const unlistedTool = createTool({
  id: 'unlistedTool',
  description: 'not on any allow-list',
  inputSchema: z.object({}),
  execute: async () => {
    unlistedCalls.push('unlistedTool');
    return { ran: true };
  },
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

function seedMastra(): Mastra {
  const mastra = new Mastra({ logger: false, storage: new InMemoryStore() });
  (globalThis as { tourbillonMastra?: Mastra }).tourbillonMastra = mastra;
  return mastra;
}

before(async () => {
  gate = await import('./tool-gate');
  factory = await import('./agent-factory');
  controller = await import('./controller-config');
  chat = await import('./chat-controller');
  mcp = await import('./tools/mcp-tools');
  api = await import('./tools/api-client');
  shared = await import('@tourbillon/shared');
  // Agent builders share one Memory per config; serve an in-memory one.
  (globalThis as { mastraMemoryByKey?: Map<string, Memory> }).mastraMemoryByKey = new Map([
    ['base', new Memory({ storage: new InMemoryStore() })],
  ]);
});

beforeEach(() => {
  for (const key of SEARCH_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  agentRows.clear();
  companyRows.clear();
  deniedRows.length = 0;
  fetchCalls.length = 0;
  mcpCalls.length = 0;
  unlistedCalls.length = 0;
  loadAgentOverride = null;
  makeCompany(COMPANY_A);
  makeCompany(COMPANY_B);
  globalThis.fetch = (async (url: string | URL) => {
    fetchCalls.push(String(url));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  gate.setToolGateDepsForTests({
    loadAgent: async (id) => {
      if (loadAgentOverride) return (await loadAgentOverride(id)) as never;
      const row = agentRows.get(id);
      return row ? { ...row } : undefined;
    },
    loadCompany: async (id) => {
      const row = companyRows.get(id);
      return row ? ({ ...row } as never) : undefined;
    },
    recordDenied: async (row) => {
      deniedRows.push({ ...row });
    },
    warn: (line) => {
      gateWarnings.push(line);
    },
    now: () => clock,
  });
  gateWarnings.length = 0;
  seedMastra();
});

afterEach(() => {
  for (const key of SEARCH_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  globalThis.fetch = realFetch;
});

after(() => {
  gate.setToolGateDepsForTests();
});

describe('tool permission gate: unknown tools', () => {
  it('an invented tool name is not run on the heartbeat durable agent (tracing off)', async () => {
    const a = makeAgent('agent-hb', COMPANY_A);
    const durable = await factory.createDurableAgentWithSkills(a);
    const { outcomes } = await runAgent(durable, scriptedModel([['inventedTool']]), contextFor(a));
    assert.equal(outcomes[0]?.error, 'ToolNotFoundError');
    assert.equal(fetchCalls.length, 0);
  });

  it('an invented tool name is not run on the heartbeat durable agent (tracing on)', async () => {
    process.env.OBSERVABILITY_ENABLED = 'true';
    const a = makeAgent('agent-hb-traced', COMPANY_A);
    const durable = await factory.createDurableAgentWithSkills(a);
    const { outcomes } = await runAgent(durable, scriptedModel([['inventedTool']]), contextFor(a));
    assert.equal(outcomes[0]?.error, 'ToolNotFoundError');
    assert.equal(fetchCalls.length, 0);
  });

  it('an invented tool name is not run on the harness controller agent', async () => {
    const a = makeAgent('agent-harness', COMPANY_A, { adapterType: 'harness_local' });
    const { agent } = await controller.buildControllerModes(a);
    const { outcomes } = await runAgent(agent, scriptedModel([['inventedTool']]), contextFor(a));
    assert.equal(outcomes[0]?.error, 'ToolNotFoundError');
    assert.equal(fetchCalls.length, 0);
  });

  it('an invented tool name is not run on the chat agent', async () => {
    const a = makeAgent('agent-chat', COMPANY_A);
    const agent = await chat.createChatAgentWithSkills(a);
    const { outcomes } = await runAgent(agent, scriptedModel([['inventedTool']]), contextFor(a, `chat-${a.id}`));
    assert.equal(outcomes[0]?.error, 'ToolNotFoundError');
    assert.equal(fetchCalls.length, 0);
  });

  for (const surface of ['heartbeat', 'harness', 'chat'] as const) {
    it(`a tool outside the allow-list supplied at call time is denied on ${surface}`, async () => {
      const a = makeAgent(`agent-extra-${surface}`, COMPANY_A);
      const agent =
        surface === 'heartbeat'
          ? await factory.createAgentWithSkills(a)
          : surface === 'harness'
            ? (await controller.buildControllerModes(a)).agent
            : await chat.createChatAgentWithSkills(a);
      const { outcomes } = await runAgent(agent, scriptedModel([['unlistedTool']]), contextFor(a), {
        toolsets: { extra: { unlistedTool } },
      });
      deniedOutcome(outcomes[0], 'not_allowed');
      assert.deepEqual(unlistedCalls, []);
    });
  }
});

describe('tool permission gate: tools stay with their agent', () => {
  it('each agent runs only its own allow-listed tools; the registry stays empty; denials are logged', async () => {
    process.env.OBSERVABILITY_ENABLED = 'true';
    const mastra = seedMastra();
    const a = makeAgent('agent-a', COMPANY_A, { role: 'ceo', assignedToolsets: ['roster'], mcpServerIds: ['filesystem-local'] });
    const b = makeAgent('agent-b', COMPANY_B);
    primeFilesystemMcp(COMPANY_A);

    const durableA = await factory.createDurableAgentWithSkills(a);
    const aTools = await durableA.agent.listTools({ requestContext: contextFor(a) });
    assert.ok(aTools.createAgentTool && aTools.filesystem_write_file, 'A holds createAgent and the MCP write tool');

    const durableB = await factory.createDurableAgentWithSkills(b);
    assert.equal(gate.isMastraToolRegistryEmpty(mastra), true, 'Mastra tool registry is empty');
    assert.equal(Object.keys(mastra.listTools() ?? {}).length, 0);

    const { outcomes } = await runAgent(
      durableB,
      scriptedModel([['createAgentTool', 'createAgent', 'filesystem_write_file']]),
      contextFor(b),
    );
    assert.equal(outcomes.length, 3);
    for (const outcome of outcomes) {
      assert.ok(outcome.error === 'ToolNotFoundError' || outcome.result?.error === 'tool_not_allowed', JSON.stringify(outcome));
    }
    assert.equal(fetchCalls.length, 0, 'createAgent did not run');
    assert.deepEqual(mcpCalls, [], 'MCP write did not run');

    // Tool instances are bound to the agent they were built for.
    const denied = await aTools.filesystem_write_file.execute({}, { requestContext: contextFor(b) });
    assert.equal(denied.error, 'tool_not_allowed');
    assert.equal(denied.reason, 'context_mismatch');
    const deniedCreate = await aTools.createAgentTool.execute({ name: 'x', title: 'y', role: 'engineer' }, { requestContext: contextFor(b) });
    assert.equal(deniedCreate.error, 'tool_not_allowed');
    assert.deepEqual(mcpCalls, []);
    assert.equal(fetchCalls.length, 0);
    await flush();
    assert.ok(
      deniedRows.some((r) => r.agentId === a.id && r.reason === 'context_mismatch' && r.tool === 'filesystem_write_file'),
      'agent.tool_denied row written',
    );
    assert.ok(deniedRows.every((r) => !('args' in r) && !('input' in r)), 'no arguments in denial rows');
  });

  it('the registry check refuses a Mastra instance holding tools', () => {
    const mastra = new Mastra({ logger: false, tools: { stray: unlistedTool } as never });
    assert.equal(gate.isMastraToolRegistryEmpty(mastra), false);
    assert.throws(() => gate.assertMastraToolRegistryEmpty(mastra), /registry must stay empty/);
    assert.doesNotThrow(() => gate.assertMastraToolRegistryEmpty(new Mastra({ logger: false })));
  });
});

describe('tool permission gate: changes apply mid-run', () => {
  it('a toolset removed mid-run is denied on the next call (within the cache window)', async () => {
    const a = makeAgent('agent-roster', COMPANY_A, { assignedToolsets: ['roster'] });
    const durable = await factory.createDurableAgentWithSkills(a);
    const model = scriptedModel([['listAgentsTool'], ['listAgentsTool']], (n) => {
      if (n === 2) editAgent(a.id, { assignedToolsets: [] });
    });
    const { outcomes } = await runAgent(durable, model, contextFor(a));
    assert.equal(outcomes[0]?.result?.error, undefined, 'first call ran');
    assert.equal(fetchCalls.length, 1);
    deniedOutcome(outcomes[1], 'not_in_toolset');
    assert.equal(fetchCalls.length, 1, 'second call did not run');
  });

  it('an MCP server removed mid-run is denied on the next call', async () => {
    const a = makeAgent('agent-mcp-removed', COMPANY_A, { mcpServerIds: ['filesystem-local'] });
    primeFilesystemMcp(COMPANY_A);
    const durable = await factory.createDurableAgentWithSkills(a);
    const model = scriptedModel([['filesystem_read_file'], ['filesystem_read_file']], (n) => {
      if (n === 2) editAgent(a.id, { mcpServerIds: [] });
    });
    const { outcomes } = await runAgent(durable, model, contextFor(a));
    assert.equal(outcomes[0]?.result?.ok, true);
    deniedOutcome(outcomes[1], 'mcp_server_not_allowed');
    assert.deepEqual(mcpCalls, ['filesystem_read_file']);
  });

  it('an MCP tool policy deny added mid-run is denied on the next call', async () => {
    const a = makeAgent('agent-mcp-policy', COMPANY_A, { mcpServerIds: ['filesystem-local'] });
    primeFilesystemMcp(COMPANY_A);
    const durable = await factory.createDurableAgentWithSkills(a);
    const model = scriptedModel([['filesystem_write_file'], ['filesystem_write_file']], (n) => {
      if (n === 2) editAgent(a.id, { runtimeConfig: { mcpToolPolicy: { 'filesystem-local': { deny: ['write_file'] } } } });
    });
    const { outcomes } = await runAgent(durable, model, contextFor(a));
    assert.equal(outcomes[0]?.result?.ok, true);
    deniedOutcome(outcomes[1], 'mcp_policy_denied');
    assert.deepEqual(mcpCalls, ['filesystem_write_file']);
  });

  it('a cached chat agent loses a removed toolset on the next turn', async () => {
    const a = makeAgent('agent-chat-cached', COMPANY_A, { assignedToolsets: ['roster'] });
    const agent = await chat.createChatAgentWithSkills(a);
    const first = await runAgent(agent, scriptedModel([['listAgentsTool']]), contextFor(a, `chat-${a.id}`));
    assert.equal(first.outcomes[0]?.result?.error, undefined);
    editAgent(a.id, { assignedToolsets: [] });
    const second = await runAgent(agent, scriptedModel([['listAgentsTool']]), contextFor(a, `chat-${a.id}`));
    deniedOutcome(second.outcomes[0], 'not_in_toolset');
    assert.equal(fetchCalls.length, 1);
  });

  it('within the cache window a change is not yet seen; after it, it is', async () => {
    const a = makeAgent('agent-window', COMPANY_A, { assignedToolsets: ['roster'] });
    const ctx = { agentId: a.id, companyId: COMPANY_A, surface: 'heartbeat' as const };
    const rc = contextFor(a);
    assert.equal((await gate.checkToolPermission({ ...ctx, toolName: 'listAgentsTool', requestContext: rc })).allowed, true);
    agentRows.set(a.id, { ...agentRows.get(a.id)!, assignedToolsets: [], updatedAt: new Date(clock + 1) } as AgentRow);
    clock += gate.TOOL_GATE_CACHE_TTL_MS - 1;
    assert.equal((await gate.checkToolPermission({ ...ctx, toolName: 'listAgentsTool', requestContext: rc })).allowed, true);
    clock += 1;
    assert.equal((await gate.checkToolPermission({ ...ctx, toolName: 'listAgentsTool', requestContext: rc })).allowed, false);
  });
});

describe('tool permission gate: agent and company status', () => {
  it('an agent archived mid-run is denied every tool, including MCP, web search and skills', async () => {
    const a = makeAgent('agent-archived', COMPANY_A, {
      assignedToolsets: ['web-search'],
      mcpServerIds: ['filesystem-local'],
    });
    editCompany(COMPANY_A, { settings: { searxngUrl: 'http://searxng.test' } });
    primeFilesystemMcp(COMPANY_A);
    const durable = await factory.createDurableAgentWithSkills(a, { companySettings: { searxngUrl: 'http://searxng.test' } as never });
    const model = scriptedModel([['getDateTimeTool'], ['filesystem_read_file', 'searxngSearchTool', 'listSkillsTool']], (n) => {
      if (n === 2) editAgent(a.id, { status: 'archived' });
    });
    const { outcomes } = await runAgent(durable, model, contextFor(a));
    assert.equal(outcomes[0]?.result?.error, undefined, 'first call ran');
    for (const outcome of outcomes.slice(1)) deniedOutcome(outcome, 'agent_archived');
    assert.deepEqual(mcpCalls, []);
    assert.equal(fetchCalls.length, 0);
  });

  it('an agent paused mid-run is denied on heartbeat and harness, not in chat', async () => {
    const a = makeAgent('agent-paused', COMPANY_A);
    const durable = await factory.createDurableAgentWithSkills(a);
    const model = scriptedModel([['getDateTimeTool'], ['getDateTimeTool']], (n) => {
      if (n === 2) editAgent(a.id, { status: 'paused' });
    });
    const { outcomes } = await runAgent(durable, model, contextFor(a));
    assert.equal(outcomes[0]?.result?.error, undefined);
    deniedOutcome(outcomes[1], 'agent_paused');

    const rc = contextFor(a);
    const harness = await gate.checkToolPermission({ agentId: a.id, companyId: COMPANY_A, surface: 'harness', toolName: 'getDateTimeTool', requestContext: rc });
    assert.deepEqual(harness, { allowed: false, reason: 'agent_paused' });
    const chatDecision = await gate.checkToolPermission({ agentId: a.id, companyId: COMPANY_A, surface: 'chat', toolName: 'getDateTimeTool', requestContext: rc });
    assert.deepEqual(chatDecision, { allowed: true });
  });

  it('pending-approval agents and inactive companies are denied', async () => {
    const pending = makeAgent('agent-pending', COMPANY_A, { status: 'pending_approval' });
    const d1 = await gate.checkToolPermission({ agentId: pending.id, companyId: COMPANY_A, surface: 'chat', toolName: 'getDateTimeTool', requestContext: contextFor(pending) });
    assert.deepEqual(d1, { allowed: false, reason: 'agent_pending_approval' });
    makeCompany('company-paused', { status: 'paused' });
    const c = makeAgent('agent-in-paused-co', 'company-paused');
    const d2 = await gate.checkToolPermission({ agentId: c.id, companyId: c.companyId, surface: 'heartbeat', toolName: 'getDateTimeTool', requestContext: contextFor(c) });
    assert.deepEqual(d2, { allowed: false, reason: 'company_inactive' });
  });
});

describe('tool permission gate: MCP allow-list', () => {
  it('an allowed server and policy-allowed tool runs', async () => {
    const a = makeAgent('agent-mcp-ok', COMPANY_A, { mcpServerIds: ['filesystem-local'] });
    primeFilesystemMcp(COMPANY_A);
    const durable = await factory.createDurableAgentWithSkills(a);
    const { outcomes } = await runAgent(durable, scriptedModel([['filesystem_read_file']]), contextFor(a));
    assert.equal(outcomes[0]?.result?.ok, true);
    assert.deepEqual(mcpCalls, ['filesystem_read_file']);
  });

  it('a policy-denied MCP tool is denied (and not assembled)', async () => {
    const a = makeAgent('agent-mcp-deny', COMPANY_A, {
      mcpServerIds: ['filesystem-local'],
      runtimeConfig: { mcpToolPolicy: { 'filesystem-local': { deny: ['write_file'] } } },
    });
    primeFilesystemMcp(COMPANY_A);
    const decision = await gate.checkToolPermission({ agentId: a.id, companyId: COMPANY_A, surface: 'heartbeat', toolName: 'filesystem_write_file', requestContext: contextFor(a) });
    assert.deepEqual(decision, { allowed: false, reason: 'mcp_policy_denied' });
    const durable = await factory.createDurableAgentWithSkills(a);
    const { outcomes } = await runAgent(durable, scriptedModel([['filesystem_write_file']]), contextFor(a));
    assert.equal(outcomes[0]?.error, 'ToolNotFoundError');
    assert.deepEqual(mcpCalls, []);
  });

  it('a server not on the company allow-list is denied', async () => {
    const a = makeAgent('agent-mcp-unlisted', COMPANY_A, { mcpServerIds: ['filesystem-local'] });
    editCompany(COMPANY_A, { allowedMcpServerIds: ['github-mcp'] });
    const decision = await gate.checkToolPermission({ agentId: a.id, companyId: COMPANY_A, surface: 'heartbeat', toolName: 'filesystem_read_file', requestContext: contextFor(a) });
    assert.deepEqual(decision, { allowed: false, reason: 'mcp_server_not_allowed' });
  });

  it('a server dropped from the company allow-list mid-run is denied', async () => {
    const a = makeAgent('agent-mcp-co-drop', COMPANY_A, { mcpServerIds: ['filesystem-local'] });
    primeFilesystemMcp(COMPANY_A);
    const durable = await factory.createDurableAgentWithSkills(a);
    const model = scriptedModel([['filesystem_read_file'], ['filesystem_read_file']], (n) => {
      if (n === 2) editCompany(COMPANY_A, { allowedMcpServerIds: ['github-mcp'] });
    });
    const { outcomes } = await runAgent(durable, model, contextFor(a));
    assert.equal(outcomes[0]?.result?.ok, true);
    deniedOutcome(outcomes[1], 'mcp_server_not_allowed');
  });
});

describe('tool permission gate: configuration-dependent tools', () => {
  it('sendToAgent is denied once mail is disabled', async () => {
    const a = makeAgent('agent-mail', COMPANY_A);
    const durable = await factory.createDurableAgentWithSkills(a);
    const model = scriptedModel([['sendToAgentTool']], (n) => {
      if (n === 1) editAgent(a.id, { runtimeConfig: { mail: { enabled: false } } });
    });
    const { outcomes } = await runAgent(durable, model, contextFor(a));
    deniedOutcome(outcomes[0], 'mail_disabled');
    assert.equal(fetchCalls.length, 0);
  });

  it('web search is denied when it is not configured', async () => {
    const a = makeAgent('agent-search', COMPANY_A, { assignedToolsets: ['web-search'] });
    editCompany(COMPANY_A, { settings: { searxngUrl: 'http://searxng.test' } });
    const durable = await factory.createDurableAgentWithSkills(a, { companySettings: { searxngUrl: 'http://searxng.test' } as never });
    const model = scriptedModel([['searxngSearchTool']], (n) => {
      if (n === 1) editCompany(COMPANY_A, { settings: {} });
    });
    const { outcomes } = await runAgent(durable, model, contextFor(a));
    deniedOutcome(outcomes[0], 'web_search_not_configured');
    assert.equal(fetchCalls.length, 0);
  });

  it('browser / computer tools are denied by default', async () => {
    const a = makeAgent('agent-browser', COMPANY_A);
    const decision = await gate.checkToolPermission({ agentId: a.id, companyId: COMPANY_A, surface: 'harness', toolName: 'browser_navigate', requestContext: contextFor(a) });
    assert.deepEqual(decision, { allowed: false, reason: 'browser_tools_disabled' });
  });
});

describe('tool permission gate: fails closed', () => {
  async function expectGateErrorRun(a: AgentRow, rc: unknown, reason = 'gate_error') {
    const durable = await factory.createDurableAgentWithSkills(a);
    const { outcomes, text } = await runAgent(durable, scriptedModel([['getIdentityTool']]), rc);
    deniedOutcome(outcomes[0], reason);
    assert.equal(fetchCalls.length, 0, 'tool never called');
    assert.equal(text, 'done');
  }

  it('a throwing lookup denies with gate_error', async () => {
    const a = makeAgent('agent-throw', COMPANY_A);
    loadAgentOverride = async () => {
      throw new Error('unexpected');
    };
    await expectGateErrorRun(a, contextFor(a));
  });

  it('database down denies with gate_error', async () => {
    const a = makeAgent('agent-db-down', COMPANY_A);
    loadAgentOverride = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    };
    await expectGateErrorRun(a, contextFor(a));
  });

  it('a lookup slower than the timeout denies with gate_error', async () => {
    const a = makeAgent('agent-slow', COMPANY_A);
    loadAgentOverride = () => new Promise(() => undefined);
    const started = Date.now();
    const decision = await gate.checkToolPermission({ agentId: a.id, companyId: COMPANY_A, surface: 'heartbeat', toolName: 'getIdentityTool', requestContext: contextFor(a) });
    assert.deepEqual(decision, { allowed: false, reason: 'gate_error' });
    assert.ok(Date.now() - started >= gate.TOOL_GATE_TIMEOUT_MS - 50);
  });

  it('missing agentId in the request context denies with gate_error', async () => {
    const a = makeAgent('agent-no-ctx', COMPANY_A);
    const rc = new RequestContext();
    rc.set('companyId', COMPANY_A);
    rc.set('runId', 'run-no-agent');
    await expectGateErrorRun(a, rc);
  });

  it('a request context for another agent denies with context_mismatch', async () => {
    const a = makeAgent('agent-ctx-a', COMPANY_A);
    const other = makeAgent('agent-ctx-other', COMPANY_A);
    await expectGateErrorRun(a, contextFor(other), 'context_mismatch');
  });

  it('a tool instance called with no context is denied and never runs', async () => {
    const a = makeAgent('agent-direct', COMPANY_A, { assignedToolsets: ['roster'] });
    const tools = await factory.assembleAgentTools(a);
    const result = (await (tools.listAgentsTool as any).execute({}, {})) as Record<string, unknown>;
    assert.equal(result.error, 'tool_not_allowed');
    assert.equal(result.reason, 'gate_error');
    assert.equal(fetchCalls.length, 0);
  });
});

describe('tool permission gate: deny is a tool result', () => {
  it('the deny output reaches the model and the run continues', async () => {
    const a = makeAgent('agent-continue', COMPANY_A);
    const durable = await factory.createDurableAgentWithSkills(a);
    const model = scriptedModel([['getDateTimeTool'], ['getDateTimeTool']], (n) => {
      if (n === 2) editAgent(a.id, { status: 'paused' });
    });
    const { outcomes, text } = await runAgent(durable, model, contextFor(a));
    deniedOutcome(outcomes[1], 'agent_paused');
    assert.equal(text, 'done', 'run finished normally');
    assert.equal(model.prompts.length, 3);
    const thirdPrompt = JSON.stringify(model.prompts[2]);
    assert.ok(thirdPrompt.includes('tool_not_allowed'), 'model saw the structured deny');
    assert.ok(thirdPrompt.includes('agent_paused'));
  });

  it('denial rows are capped per run with one summary row', async () => {
    const a = makeAgent('agent-cap', COMPANY_A);
    const rc = contextFor(a, 'run-cap');
    for (let i = 0; i < gate.TOOL_DENIED_ROWS_PER_RUN + 10; i += 1) {
      await gate.checkToolPermission({ agentId: a.id, companyId: COMPANY_A, surface: 'heartbeat', toolName: `invented${i}`, requestContext: rc });
    }
    await flush();
    const rows = deniedRows.filter((r) => r.runId === 'run-cap');
    assert.equal(rows.length, gate.TOOL_DENIED_ROWS_PER_RUN + 1);
    assert.equal(rows.filter((r) => r.summary === true).length, 1);
    assert.equal(rows.at(-1)?.summary, true);
  });
});

describe('tool permission gate: one allow-list for assembly and the gate', () => {
  it('the shared tool manifest matches the tool objects', async () => {
    const { CONTROL_PLANE_TOOLS } = await import('./tools/control-plane-tools');
    const { ROLE_TOOLS } = await import('./tools/role-tools');
    const { ASSIGNABLE_TOOLS } = await import('./tools/assignable-tools');
    const keyedIds = (tools: Record<string, unknown>) =>
      Object.entries(tools).map(([key, tool]) => {
        const id = (tool as { id: string }).id;
        assert.equal(key, shared.toolKeyForId(id), `record key for ${id}`);
        return id;
      });
    assert.deepEqual(keyedIds(CONTROL_PLANE_TOOLS), [...shared.CONTROL_PLANE_TOOL_IDS]);
    assert.deepEqual(Object.keys(ROLE_TOOLS).sort(), Object.keys(shared.ROLE_TOOLSET_TOOL_IDS).sort());
    for (const [toolsetId, tools] of Object.entries(ROLE_TOOLS)) {
      assert.deepEqual(keyedIds(tools), [...shared.ROLE_TOOLSET_TOOL_IDS[toolsetId]!], toolsetId);
    }
    assert.deepEqual(Object.keys(ASSIGNABLE_TOOLS).sort(), [...shared.ALL_ASSIGNABLE_TOOL_IDS].sort());
    for (const id of [...shared.CONTROL_PLANE_TOOL_IDS, ...shared.ALL_ASSIGNABLE_TOOL_IDS]) {
      assert.ok(factory.STATIC_TOOLS_BY_ID[id], id);
    }
  });

  it('assembled tools are exactly the resolved allow-list', async () => {
    const cases: Array<Partial<AgentRow>> = [
      {},
      { role: 'ceo', assignedToolsets: ['roster', 'approvals', 'comments', 'nitter'] },
      { assignedToolsets: ['web-search', 'web-search-tavily'], runtimeConfig: { mail: { enabled: false } } },
      { role: 'custom', runtimeConfig: { assignedTools: ['listGoals', 'createIssue'] } },
    ];
    for (const [i, over] of cases.entries()) {
      const a = makeAgent(`agent-parity-${i}`, COMPANY_A, over);
      const tools = await factory.assembleAgentTools(a);
      const allowed = shared.resolveAllowedToolNames(a, { settings: null });
      assert.deepEqual(Object.keys(tools), allowed.staticToolIds.map(shared.toolKeyForId), `case ${i}`);
    }
  });
});

describe('MCP client cache key', () => {
  it('hashes the credential and scopes by company and server', () => {
    const k1 = mcp.mcpClientCacheKey({ serverId: 'buffer-mcp', companyId: COMPANY_A, apiKey: 'sk-proj-aaaaaaaa1111' });
    const k2 = mcp.mcpClientCacheKey({ serverId: 'buffer-mcp', companyId: COMPANY_A, apiKey: 'sk-proj-aaaaaaaa2222' });
    const k3 = mcp.mcpClientCacheKey({ serverId: 'buffer-mcp', companyId: COMPANY_B, apiKey: 'sk-proj-aaaaaaaa1111' });
    const k4 = mcp.mcpClientCacheKey({ serverId: 'github-mcp', companyId: COMPANY_A, apiKey: 'sk-proj-aaaaaaaa1111' });
    assert.equal(new Set([k1, k2, k3, k4]).size, 4);
    for (const key of [k1, k2, k3, k4]) assert.ok(!key.includes('sk-proj'), 'no raw credential in the key');
    assert.notEqual(
      mcp.mcpClientCacheKey({ serverId: 'github-mcp', companyId: COMPANY_A }),
      mcp.mcpClientCacheKey({ serverId: 'github-mcp', companyId: COMPANY_B }),
    );
  });
});

describe('tool permission gate: overhead', () => {
  it('adds at most 5 ms p95 per call with a warm cache', async () => {
    const a = makeAgent('agent-perf', COMPANY_A, { role: 'ceo', assignedToolsets: ['roster', 'approvals'], mcpServerIds: ['filesystem-local'] });
    const rc = contextFor(a);
    const input = { agentId: a.id, companyId: COMPANY_A, surface: 'heartbeat' as const, toolName: 'filesystem_read_file', requestContext: rc };
    await gate.checkToolPermission(input);
    const samples: number[] = [];
    for (let i = 0; i < 5_000; i += 1) {
      const t0 = performance.now();
      const decision = await gate.checkToolPermission(input);
      samples.push(performance.now() - t0);
      assert.equal(decision.allowed, true);
    }
    samples.sort((x, y) => x - y);
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    const p50 = samples[Math.floor(samples.length * 0.5)]!;
    console.log(`[tool-gate overhead] warm-cache p50=${p50.toFixed(4)}ms p95=${p95.toFixed(4)}ms n=${samples.length}`);
    assert.ok(p95 <= 5, `p95 ${p95}ms`);
  });
});

describe('tool permission gate: outbound host allow-list', () => {
  function allowlistCompany(hosts: string[]) {
    editCompany(COMPANY_A, {
      settings: { searxngUrl: 'http://searxng.test', toolEgressAllowList: hosts },
    });
  }

  for (const surface of ['heartbeat', 'harness', 'chat'] as const) {
    it(`allows every host by default on ${surface}`, async () => {
      const a = makeAgent(`agent-egress-open-${surface}`, COMPANY_A, { assignedToolsets: ['web-search'] });
      editCompany(COMPANY_A, { settings: { searxngUrl: 'http://searxng.test' } });
      const rc = contextFor(a);
      const decision = await gate.checkToolPermission({
        agentId: a.id,
        companyId: COMPANY_A,
        surface,
        toolName: 'searxngSearchTool',
        requestContext: rc,
      });
      assert.deepEqual(decision, { allowed: true });
    });

    it(`blocks a host off the company list on ${surface}`, async () => {
      const a = makeAgent(`agent-egress-block-${surface}`, COMPANY_A, { assignedToolsets: ['web-search'] });
      allowlistCompany(['allowed.example']);
      const decision = await gate.checkToolPermission({
        agentId: a.id,
        companyId: COMPANY_A,
        surface,
        toolName: 'searxngSearchTool',
        requestContext: contextFor(a),
      });
      assert.deepEqual(decision, { allowed: false, reason: 'egress_not_allowed', host: 'searxng.test' });
      await flush();
      assert.ok(
        deniedRows.some(
          (r) => r.agentId === a.id && r.reason === 'egress_not_allowed' && r.host === 'searxng.test' && r.tool === 'searxngSearchTool',
        ),
        'agent.tool_denied row with the host',
      );
      assert.ok(deniedRows.every((r) => !JSON.stringify(r).includes('http://')), 'no full URL in the denial row');
    });
  }

  it('blocks Tavily and Nitter when their hosts are off the list', async () => {
    const a = makeAgent('agent-egress-tavily', COMPANY_A, {
      assignedToolsets: ['web-search-tavily', 'nitter'],
    });
    allowlistCompany(['allowed.example']);
    process.env.NITTER_URL = 'https://nitter.example';
    process.env.TAVILY_API_KEY = 'tvly-test';
    for (const tool of ['webSearchTavily', 'nitterSearchTweets']) {
      const decision = await gate.checkToolPermission({
        agentId: a.id,
        companyId: COMPANY_A,
        surface: 'heartbeat',
        toolName: tool,
        requestContext: contextFor(a),
      });
      assert.equal(decision.allowed, false, tool);
      assert.equal(decision.reason, 'egress_not_allowed');
    }
  });

  it('allows a tool when its configured host is listed', async () => {
    const a = makeAgent('agent-egress-ok', COMPANY_A, { assignedToolsets: ['web-search'] });
    allowlistCompany(['searxng.test']);
    const decision = await gate.checkToolPermission({
      agentId: a.id,
      companyId: COMPANY_A,
      surface: 'heartbeat',
      toolName: 'searxngSearchTool',
      requestContext: contextFor(a),
    });
    assert.deepEqual(decision, { allowed: true });
  });

  it('an agent list can only narrow the company list', async () => {
    const a = makeAgent('agent-egress-narrow', COMPANY_A, {
      assignedToolsets: ['web-search'],
      runtimeConfig: { toolEgressAllowList: ['other.example'] },
    });
    allowlistCompany(['searxng.test', 'other.example']);
    const decision = await gate.checkToolPermission({
      agentId: a.id,
      companyId: COMPANY_A,
      surface: 'heartbeat',
      toolName: 'searxngSearchTool',
      requestContext: contextFor(a),
    });
    assert.deepEqual(decision, { allowed: false, reason: 'egress_not_allowed', host: 'searxng.test' });
  });

  it('blocks an HTTP MCP server whose host is off the list, allows it when listed', async () => {
    const a = makeAgent('agent-egress-mcp', COMPANY_A, { mcpServerIds: ['buffer-mcp'] });
    const input = {
      agentId: a.id,
      companyId: COMPANY_A,
      surface: 'heartbeat' as const,
      toolName: 'buffer_create_post',
      requestContext: contextFor(a),
    };
    assert.deepEqual(await gate.checkToolPermission(input), { allowed: true }, 'default: allowed');
    allowlistCompany(['allowed.example']);
    assert.deepEqual(await gate.checkToolPermission(input), { allowed: false, reason: 'egress_not_allowed', host: 'mcp.buffer.com' });
    allowlistCompany(['*.buffer.com']);
    assert.deepEqual(await gate.checkToolPermission(input), { allowed: true });
  });

  it('local (stdio) MCP servers are not affected by the list', async () => {
    const a = makeAgent('agent-egress-stdio', COMPANY_A, { mcpServerIds: ['filesystem-local'] });
    allowlistCompany([]);
    const decision = await gate.checkToolPermission({
      agentId: a.id,
      companyId: COMPANY_A,
      surface: 'heartbeat',
      toolName: 'filesystem_read_file',
      requestContext: contextFor(a),
    });
    assert.deepEqual(decision, { allowed: true });
  });

  it('each covered static tool is checked', async () => {
    const a = makeAgent('agent-egress-each', COMPANY_A, {
      assignedToolsets: ['web-search', 'web-search-tavily', 'nitter'],
    });
    process.env.NITTER_URL = 'https://nitter.example';
    process.env.TAVILY_API_KEY = 'tvly-test';
    const check = (toolName: string) =>
      gate.checkToolPermission({ agentId: a.id, companyId: COMPANY_A, surface: 'chat', toolName, requestContext: contextFor(a) });
    const expected: Record<string, string> = {
      searxngSearchTool: 'searxng.test',
      searxngNewsSearchTool: 'searxng.test',
      webSearchTavilyTool: 'api.tavily.com',
      nitterSearchTweetsTool: 'nitter.example',
      nitterFeedUserTool: 'nitter.example',
      nitterSearchUsersTool: 'nitter.example',
    };
    allowlistCompany(['unrelated.example']);
    for (const [tool, host] of Object.entries(expected)) {
      assert.deepEqual(await check(tool), { allowed: false, reason: 'egress_not_allowed', host }, tool);
    }
    allowlistCompany(['searxng.test', 'api.tavily.com', 'nitter.example']);
    for (const tool of Object.keys(expected)) assert.deepEqual(await check(tool), { allowed: true }, tool);
    assert.deepEqual(
      [...shared.TOOL_EGRESS_COVERED_TOOL_IDS].map(shared.toolKeyForId).sort(),
      Object.keys(expected).sort(),
      'every covered tool id is exercised',
    );
  });

  it('a blocked HTTP MCP server is not connected when tools are built', async () => {
    const a = makeAgent('agent-egress-build', COMPANY_A, { mcpServerIds: ['buffer-mcp'] });
    const blockedSettings = { toolEgressAllowList: ['allowed.example'] } as never;
    const blocked = await mcp.buildMCPTools(a, { companySettings: blockedSettings });
    assert.deepEqual(Object.keys(blocked), []);
    const def = (await import('@tourbillon/shared/mcp-registry')).getMcpServerDefinition('buffer-mcp')!;
    assert.equal(mcp.mcpServerEgressBlockedHost('buffer-mcp', def, shared.resolveToolEgressPolicy(blockedSettings)), 'mcp.buffer.com');
    assert.equal(mcp.mcpServerEgressBlockedHost('buffer-mcp', def, shared.resolveToolEgressPolicy({ toolEgressAllowList: ['mcp.buffer.com'] })), null);
  });

  it('MCP client cache keys differ by allow-list and are unchanged without one', () => {
    const base = { serverId: 'buffer-mcp', companyId: COMPANY_A, apiKey: 'k' };
    const open = mcp.mcpClientCacheKey(base);
    assert.equal(mcp.mcpClientCacheKey({ ...base, egressPolicy: {} }), open);
    const k1 = mcp.mcpClientCacheKey({ ...base, egressPolicy: shared.resolveToolEgressPolicy({ toolEgressAllowList: ['a.example'] }) });
    const k2 = mcp.mcpClientCacheKey({ ...base, egressPolicy: shared.resolveToolEgressPolicy({ toolEgressAllowList: ['b.example'] }) });
    assert.equal(new Set([open, k1, k2]).size, 3);
  });

  it('the MCP HTTP fetch refuses a redirect off the list', async () => {
    const hops: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      hops.push(String(url));
      return new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/mcp' } });
    }) as typeof fetch;
    const mcpFetch = mcp.createMcpHttpFetch('k', undefined, shared.resolveToolEgressPolicy({ toolEgressAllowList: ['mcp.buffer.com'] }));
    await assert.rejects(() => mcpFetch('https://mcp.buffer.com/mcp', { method: 'POST', body: '{}' }), shared.ToolEgressBlockedError);
    assert.deepEqual(hops, ['https://mcp.buffer.com/mcp']);
  });

  it('the MCP HTTP fetch logs one warning with the server name and blocked host only', async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 302, headers: { location: 'https://elsewhere.example:8443/private/path?token=abc#frag' } })) as typeof fetch;
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warned.push(args.map(String).join(' '));
    };
    try {
      const mcpFetch = mcp.createMcpHttpFetch(
        'k',
        undefined,
        shared.resolveToolEgressPolicy({ toolEgressAllowList: ['mcp.buffer.com'] }),
        'buffer-mcp',
      );
      await assert.rejects(() => mcpFetch('https://mcp.buffer.com/mcp?session=s1', { method: 'POST', body: '{}' }), shared.ToolEgressBlockedError);
    } finally {
      console.warn = realWarn;
    }
    assert.equal(warned.length, 1);
    assert.equal(warned[0], '[mcp-tools] MCP server buffer-mcp: blocked outbound host elsewhere.example (not on the tool allow-list)');
    for (const leak of ['/private', 'path', 'token', 'abc', 'frag', 'session', '8443', 'agent']) {
      assert.ok(!warned[0]!.includes(leak), leak);
    }
  });

  it('the MCP HTTP fetch logs nothing when the request stays on the list', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warned.push(args.map(String).join(' '));
    };
    try {
      const mcpFetch = mcp.createMcpHttpFetch('k', undefined, shared.resolveToolEgressPolicy({ toolEgressAllowList: ['mcp.buffer.com'] }), 'buffer-mcp');
      assert.equal((await mcpFetch('https://mcp.buffer.com/mcp', { method: 'POST', body: '{}' })).status, 200);
    } finally {
      console.warn = realWarn;
    }
    assert.deepEqual(warned, []);
  });

  it('a malformed stored company list fails closed and logs one id-only warning per cache refresh', async () => {
    const a = makeAgent('agent-egress-malformed', COMPANY_A, { assignedToolsets: ['web-search'] });
    editCompany(COMPANY_A, {
      settings: { searxngUrl: 'http://searxng.test', toolEgressAllowList: { hosts: ['searxng.test'] } },
    });
    const input = { agentId: a.id, companyId: COMPANY_A, surface: 'heartbeat' as const, toolName: 'searxngSearchTool', requestContext: contextFor(a) };
    assert.deepEqual(await gate.checkToolPermission(input), { allowed: false, reason: 'egress_not_allowed', host: 'searxng.test' });
    assert.equal((await gate.checkToolPermission(input)).allowed, false);
    assert.deepEqual(gateWarnings, [
      `[tool-egress] malformed outbound host allow-list for company ${COMPANY_A}; unreadable entries match no host until the list is saved again`,
    ]);
    clock += gate.TOOL_GATE_CACHE_TTL_MS;
    assert.equal((await gate.checkToolPermission(input)).allowed, false);
    assert.equal(gateWarnings.length, 2, 'one more line after the cache refresh');
    assert.ok(gateWarnings.every((line) => !line.includes('searxng.test') && !line.includes('hosts')));
  });

  it('a malformed stored agent list names the agent id only; a valid list logs nothing', async () => {
    const a = makeAgent('agent-egress-malformed-agent', COMPANY_A, {
      assignedToolsets: ['web-search'],
      runtimeConfig: { toolEgressAllowList: ['searxng.test', 42] as never },
    } as never);
    editCompany(COMPANY_A, { settings: { searxngUrl: 'http://searxng.test' } });
    const input = { agentId: a.id, companyId: COMPANY_A, surface: 'chat' as const, toolName: 'searxngSearchTool', requestContext: contextFor(a) };
    // The readable entry still applies; the unreadable one matches nothing.
    assert.deepEqual(await gate.checkToolPermission(input), { allowed: true });
    assert.deepEqual(gateWarnings, [
      `[tool-egress] malformed outbound host allow-list for agent ${a.id}; unreadable entries match no host until the list is saved again`,
    ]);
    gateWarnings.length = 0;
    const b = makeAgent('agent-egress-valid-list', COMPANY_A, {
      assignedToolsets: ['web-search'],
      runtimeConfig: { toolEgressAllowList: ['searxng.test'] },
    } as never);
    assert.deepEqual(await gate.checkToolPermission({ ...input, agentId: b.id, requestContext: contextFor(b) }), { allowed: true });
    assert.deepEqual(gateWarnings, []);
  });

  it('an IPv6 tool host is allowed under allow-all and refused under a list', async () => {
    const a = makeAgent('agent-egress-ipv6', COMPANY_A, { assignedToolsets: ['web-search'] });
    const input = { agentId: a.id, companyId: COMPANY_A, surface: 'heartbeat' as const, toolName: 'searxngSearchTool', requestContext: contextFor(a) };
    editCompany(COMPANY_A, { settings: { searxngUrl: 'http://[2001:db8::5]:8080' } });
    assert.deepEqual(await gate.checkToolPermission(input), { allowed: true });
    editCompany(COMPANY_A, { settings: { searxngUrl: 'http://[2001:db8::5]:8080', toolEgressAllowList: ['searxng.test'] } });
    clock += gate.TOOL_GATE_CACHE_TTL_MS;
    const denied = await gate.checkToolPermission(input);
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, 'egress_not_allowed');
  });

  it('a mid-run list change is seen after the cache window', async () => {
    const a = makeAgent('agent-egress-window', COMPANY_A, { assignedToolsets: ['web-search'] });
    editCompany(COMPANY_A, { settings: { searxngUrl: 'http://searxng.test' } });
    const ctx = { agentId: a.id, companyId: COMPANY_A, surface: 'heartbeat' as const };
    const rc = contextFor(a);
    assert.equal((await gate.checkToolPermission({ ...ctx, toolName: 'searxngSearchTool', requestContext: rc })).allowed, true);
    companyRows.set(COMPANY_A, {
      ...companyRows.get(COMPANY_A)!,
      settings: { searxngUrl: 'http://searxng.test', toolEgressAllowList: ['allowed.example'] },
      updatedAt: new Date(clock + 1),
    });
    clock += gate.TOOL_GATE_CACHE_TTL_MS - 1;
    assert.equal((await gate.checkToolPermission({ ...ctx, toolName: 'searxngSearchTool', requestContext: rc })).allowed, true);
    clock += 1;
    const blocked = await gate.checkToolPermission({ ...ctx, toolName: 'searxngSearchTool', requestContext: rc });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, 'egress_not_allowed');
  });

  it('fails closed when resolving egress targets throws', async () => {
    const a = makeAgent('agent-egress-err', COMPANY_A, { assignedToolsets: ['web-search'] });
    allowlistCompany(['allowed.example']);
    let resolved = 0;
    gate.setToolGateDepsForTests({
      loadAgent: async (id) => ({ ...agentRows.get(id)! }),
      loadCompany: async (id) => ({ ...companyRows.get(id)! }) as never,
      recordDenied: async (row) => {
        deniedRows.push({ ...row });
      },
      now: () => clock,
      resolveEgressTargets: () => {
        resolved += 1;
        throw new Error('unexpected');
      },
    });
    const decision = await gate.checkToolPermission({
      agentId: a.id,
      companyId: COMPANY_A,
      surface: 'heartbeat',
      toolName: 'searxngSearchTool',
      requestContext: contextFor(a),
    });
    assert.deepEqual(decision, { allowed: false, reason: 'gate_error' });
    assert.equal(resolved, 1, 'the egress lookup itself failed (not the row lookup)');
  });

  it('a denied egress call never runs the tool on the heartbeat agent', async () => {
    const a = makeAgent('agent-egress-run', COMPANY_A, { assignedToolsets: ['web-search'] });
    allowlistCompany(['allowed.example']);
    const durable = await factory.createDurableAgentWithSkills(a, {
      companySettings: { searxngUrl: 'http://searxng.test', toolEgressAllowList: ['allowed.example'] } as never,
    });
    const { outcomes } = await runAgent(durable, scriptedModel([['searxngSearchTool']]), contextFor(a));
    deniedOutcome(outcomes[0], 'egress_not_allowed');
    assert.equal(fetchCalls.length, 0);
  });
});
