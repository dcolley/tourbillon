/**
 * CONCIERGE-PARAMS S1 + CONCIERGE-OM S1 (gates #195/#194): chat assembly wiring pins.
 *
 * Mutants that survived the gates — dropping `options.params` at the chat TokenLimiter /
 * generation site, dropping the 'chat' scope at the getAgentMemory call sites, and building
 * the AgentController omConfig through the heartbeat resolver — are all pinned here at the
 * real call sites. `buildChatRunConfig` / `buildChatOmConfig` are the extracted wiring
 * functions the production call sites use; the assembly tests drive them through
 * createChatAgentWithSkills / createChatController with recorded deps. No DB.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://user:***@127.0.0.1:5432/unused';

import {
  buildChatOmConfig,
  buildChatRunConfig,
  createChatAgentWithSkills,
  createChatController,
} from './chat-controller';
import { Memory } from '@mastra/memory';
import type { Agent as AgentRecord, LlmProvider } from '@tourbillon/db';
import type { AgentRuntimeConfig, CompanySettings } from '@tourbillon/shared';

const providerRow = {
  id: 'prov-1',
  name: 'Wiring Provider',
  type: 'openai',
  baseURL: 'http://127.0.0.1:1234/v1',
  apiKey: '***',
  headers: {},
  apiMode: 'responses',
  defaultModelSettings: { maxContextTokens: 132_000 },
  defaultModel: null,
  isDefault: false,
  stickiness: 'off',
  stickinessHeaderName: 'x-litellm-session-id',
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as LlmProvider;

function baseRecord(runtime: Record<string, unknown> = {}): AgentRecord {
  return {
    id: 'agent-wiring',
    companyId: 'company-wiring',
    name: 'Wiring',
    urlKey: `wiring-${Date.now()}`,
    role: 'engineer',
    instructionsBundleSoulMd: '',
    instructionsBundleAgentsMd: '',
    assignedSkills: ['control-plane'],
    assignedToolsets: [],
    runtimeConfig: runtime,
    adapterType: 'lmstudio',
    adapterConfig: {},
    modelId: 'qwen/qwen3.6-35b-a3b',
    providerId: 'prov-1',
    active: true,
    mcpServerIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as AgentRecord;
}

interface MemoryCall {
  settings: CompanySettings | null | undefined;
  runtime: AgentRuntimeConfig | null | undefined;
  scope: string | undefined;
}

function recordingDeps() {
  const memCalls: MemoryCall[] = [];
  const memory = new Memory({
    storage: { id: 'wiring-mem', getStore: async () => undefined } as never,
    options: { lastMessages: 20 },
  });
  return {
    memCalls,
    deps: {
      getMemory: async (
        settings?: CompanySettings | null,
        runtime?: AgentRuntimeConfig | null,
        scope?: 'heartbeat' | 'chat',
      ) => {
        memCalls.push({ settings, runtime, scope });
        return memory;
      },
      resolveProviderRow: async () => ({ row: providerRow, fallbackFrom: null }),
    },
  };
}

const CONCERGE_PARAMS = { maxContextTokens: 65_536, maxOutputTokens: 2_048 };

/** The first configured input processor is the TokenLimiter; its private maxTokens is the trim limit. */
async function limiterLimit(agent: object): Promise<number | undefined> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = agent as any;
  const procs: Array<{ id?: string; maxTokens?: number }> = await a.listConfiguredInputProcessors();
  const tokenLimiter = procs.find((p) => p?.id === 'token-limiter');
  return tokenLimiter?.maxTokens;
}

describe('buildChatRunConfig (CONCIERGE-PARAMS S1)', () => {
  it('params size the TokenLimiter trim limit and the generation settings', () => {
    // #204 Soft C: maxOutputTokens must NOT equal DEFAULT_OUTPUT_TOKEN_RESERVE (2_048) here —
    // with 2_048 the params-dropping mutant still lands on the 2_048 default and survives.
    // 3_072 is off-default, so a dropped params reverts generation to 2_048 and this pin goes red.
    const params = { maxContextTokens: 65_536, maxOutputTokens: 3_072 };
    const { contextBudget, generationOptions, inputProcessors } = buildChatRunConfig(
      baseRecord(),
      { defaultModelSettings: { maxContextTokens: 132_000 } } as never,
      { params },
    );
    assert.equal(contextBudget.contextTokens, 65_536, 'the params window beats the provider default');
    // 65_536 − max(3_072, 2_048) output reserve − 8_000 chat tool reserve.
    assert.equal(contextBudget.limiterLimit, 54_464, 'hard context guard sized from params');
    // Same object the chat Agent receives as inputProcessors (call site spreads this return).
    assert.equal(inputProcessors[0]?.id, 'token-limiter', 'TokenLimiter is the chat trim processor');
    assert.equal(
      (inputProcessors[0] as unknown as { maxTokens?: number }).maxTokens,
      54_464,
      'dropping options.params at the chat call site reverts this to the provider default (121_952)',
    );
    assert.equal(
      generationOptions.modelSettings?.maxOutputTokens,
      3_072,
      'generation sized from params — off-default so the dropped-params mutant lands on 2_048 and fails',
    );
  });

  it('without params the provider default window applies', () => {
    const { contextBudget, inputProcessors } = buildChatRunConfig(baseRecord(), {
      defaultModelSettings: { maxContextTokens: 132_000 },
    } as never);
    assert.equal(contextBudget.contextTokens, 132_000);
    assert.notEqual(
      (inputProcessors[0] as unknown as { maxTokens?: number }).maxTokens,
      54_464,
      'no params must NOT produce the params-sized limit (65_536 − 3_072 − 8_000)',
    );
  });

  it('a thread effort override still wins over runtime config', () => {
    const { generationOptions } = buildChatRunConfig(baseRecord(), null, {
      reasoningLevelOverride: 'high' as never,
    });
    assert.equal(generationOptions.reasoning, 'high');
  });
});

describe('buildChatOmConfig (CONCIERGE-OM S1)', () => {
  it('omConfig is built through the CHAT resolver: forced on under company off + agent off', async () => {
    const part = await buildChatOmConfig(
      { observationalMemory: { enabled: false, providerId: 'p-om', modelId: 'm-om' } },
      { observationalMemory: { mode: 'off' } } as never,
    );
    assert.deepEqual(
      part,
      {
        omConfig: {
          defaultObserverModelId: 'm-om',
          defaultReflectorModelId: 'm-om',
          defaultObservationThreshold: 30_000,
          defaultReflectionThreshold: 40_000,
          defaultMaxOutputTokens: 8192,
        },
      },
      'the heartbeat resolver would return {} here — that swap was B1',
    );
  });

  it('falls back to the concierge pair for the observer', async () => {
    const part = await buildChatOmConfig({ conciergeModel: { providerId: 'p-c', modelId: 'm-c' } }, null);
    assert.equal((part as { omConfig?: Record<string, unknown> }).omConfig?.defaultObserverModelId, 'm-c');
  });

  it('no observer model anywhere → no omConfig at all', async () => {
    assert.deepEqual(await buildChatOmConfig({}, null), {});
    assert.deepEqual(await buildChatOmConfig(null, undefined), {});
  });
});

describe('chat assembly call-site wiring (S1)', () => {
  it('createChatAgentWithSkills asks for the CHAT-scoped Memory and params-sized limiter', async () => {
    const { memCalls, deps } = recordingDeps();
    const companySettings: CompanySettings = {
      observationalMemory: { enabled: false, providerId: 'p-om', modelId: 'm-om' },
    };
    const runtime = { model: { maxContextTokens: 40_000 } } as AgentRuntimeConfig;
    const agent = await createChatAgentWithSkills(
      baseRecord(runtime as never),
      { companySettings, params: CONCERGE_PARAMS },
      deps,
    );
    assert.equal(memCalls.length, 1, 'one Memory request per chat agent build');
    assert.equal(memCalls[0].scope, 'chat', "the getAgentMemory call site must pass scope 'chat'");
    assert.equal(memCalls[0].settings, companySettings, 'company settings reach the Memory resolver');
    assert.deepEqual(memCalls[0].runtime, runtime, 'the agent runtime config reaches the Memory resolver');
    assert.equal(await limiterLimit(agent), 55_488, 'the chat Agent gets the params-sized TokenLimiter');
  });

  it('createChatController requests CHAT-scoped Memory at BOTH sites (agent + controller)', async () => {
    const { memCalls, deps } = recordingDeps();
    const companySettings: CompanySettings = {
      observationalMemory: { enabled: false, providerId: 'p-om', modelId: 'm-om' },
    };
    const controller = await createChatController(
      baseRecord(),
      { companySettings, params: CONCERGE_PARAMS },
      deps,
    );
    assert.ok(memCalls.length >= 2, 'agent site + controller site both request Memory');
    assert.deepEqual(
      [...new Set(memCalls.map((c) => c.scope))],
      ['chat'],
      "dropping 'chat' at either site (scope undefined = heartbeat) hands chat an OM-off Memory",
    );
    // #204 Soft A: was `if (om) { … }` — vacuous when omConfigPart is dropped (probe on the
    // #204 tip proved `om` is set), so the `...omConfigPart` mutant survived. Hard-assert now.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const om = (controller as any).omConfig ?? (controller as any).config?.omConfig;
    assert.ok(om, 'controller keeps the chat-forced omConfig (drop of ...omConfigPart lands here)');
    assert.equal(om.defaultObserverModelId, 'm-om', 'omConfig from the chat resolver, not heartbeat');
  });
});

/**
 * S195-S4 (#195 ACCEPT): source pin. createChatController used to resolve the provider row
 * and compute a `contextBudget` it never used (dead since the CONCIERGE-PARAMS wiring
 * landed in createChatAgentWithSkills/buildChatRunConfig). If a second budget resolution
 * creeps back into createChatController, the count leg and the slice leg both go RED.
 */
describe('createChatController source pin (S195-S4: no dead contextBudget)', () => {
  const src = readFileSync(join(__dirname, 'chat-controller.ts'), 'utf8');

  it('exactly one resolveAgentContextBudget( call site in chat-controller.ts (buildChatRunConfig)', () => {
    const calls = src.match(/resolveAgentContextBudget\(/g) ?? [];
    assert.equal(calls.length, 1, 'the only budget resolution is the live one in buildChatRunConfig');
  });

  it('createChatController body contains no budget/provider resolution chain', () => {
    const start = src.indexOf('export async function createChatController');
    assert.ok(start > 0, 'createChatController found in source');
    const body = src.slice(start);
    assert.doesNotMatch(body, /resolveAgentContextBudget\(/, 'dead contextBudget must not return to createChatController');
    assert.doesNotMatch(body, /resolveAgentProviderRow\(/, 'its provider resolution was dead too (the chat Agent site is authoritative)');
  });
});
