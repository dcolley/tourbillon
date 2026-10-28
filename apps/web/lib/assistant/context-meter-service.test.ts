/**
 * CTX-1: the meter's limit comes from the real chat budget (resolveAgentContextBudget with the
 * provider defaults and agent overrides); the thread's model choice is passed to the budget.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentContextBudget } from '../../../../packages/mastra/src/model-settings';
import { toolSchemaReserveForKind } from '@tourbillon/shared/context-budget';
import { threadContextMeter, chatObserveAfterTokens, createContextMeterDeps, type ContextMeterAgent, type ContextMeterDeps, type ContextMeterRunContextDeps } from './context-meter-service';
import type { AgentRuntimeConfig } from '@tourbillon/shared';
import { ASSISTANT_THREAD_MODEL_KEY, type ThreadModelChoice } from './thread-model';

const agent: ContextMeterAgent & { runtimeConfig: unknown } = {
  id: 'a1',
  companyId: 'c1',
  modelId: 'agent/model',
  providerId: 'p-agent',
  runtimeConfig: { model: { maxContextTokens: 64_000 } },
};
const providers: Record<string, { defaultModelSettings: { maxContextTokens: number } }> = {
  'p-agent': { defaultModelSettings: { maxContextTokens: 200_000 } },
  'p-thread': { defaultModelSettings: { maxContextTokens: 32_000 } },
};

function deps(seen: Array<ThreadModelChoice | null>, om: number | null | Error = null): ContextMeterDeps {
  return {
    async resolveBudget(a, choice) {
      seen.push(choice);
      const providerId = choice?.providerId ?? a.providerId!;
      // Thread choice: provider settings only (agent overrides still apply, like the chat controller).
      return resolveAgentContextBudget(
        { ...(a as never as object), providerId } as never,
        providers[providerId] as never,
        'chat',
      );
    },
    async observeAfterTokens() {
      if (om instanceof Error) throw om;
      return om;
    },
  };
}

describe('threadContextMeter', () => {
  it('uses the agent chat budget: agent maxContextTokens overrides the provider default', async () => {
    const seen: Array<ThreadModelChoice | null> = [];
    const m = await threadContextMeter(agent, {}, [{ role: 'user', content: 'hello there' }], deps(seen));
    assert.deepEqual(seen, [null]);
    assert.equal(m.limitTokens, 64_000);
    assert.equal(m.limitSource, 'model');
    assert.equal(m.overheadTokens, toolSchemaReserveForKind('chat'));
    assert.ok(m.usedTokens > m.overheadTokens);
  });

  it('passes the thread model choice to the budget', async () => {
    const seen: Array<ThreadModelChoice | null> = [];
    const choice = { providerId: 'p-thread', modelId: 'other/model' };
    const noOverride = { ...agent, runtimeConfig: {} };
    const m = await threadContextMeter(noOverride, { [ASSISTANT_THREAD_MODEL_KEY]: choice }, [], deps(seen));
    assert.deepEqual(seen, [choice]);
    assert.equal(m.limitTokens, 32_000);
  });

  it('reports the OM threshold and tolerates an OM lookup failure', async () => {
    const withOm = await threadContextMeter(agent, {}, [], deps([], 30_000));
    assert.equal(withOm.observeAfterTokens, 30_000);
    const failed = await threadContextMeter(agent, {}, [], deps([], new Error('db down')));
    assert.equal(failed.observeAfterTokens, null);
  });
});

/**
 * CONCIERGE-OM B1: defaultContextMeterDeps.observeAfterTokens must resolve through the CHAT
 * resolver (free-chat forces OM on), not the heartbeat one. Every case below yields null under
 * the heartbeat resolver — the meter would then ignore the OM compaction point chat actually runs.
 */
describe('chatObserveAfterTokens (CONCIERGE-OM B1)', () => {
  it('has a chat compaction point even when heartbeats have OM off', () => {
    assert.equal(
      chatObserveAfterTokens({ observationalMemory: { enabled: false, providerId: 'p1', modelId: 'm1' } }, { observationalMemory: { mode: 'off' } } as AgentRuntimeConfig),
      30_000,
    );
    assert.equal(
      chatObserveAfterTokens({ observationalMemory: { enabled: false, providerId: 'p1', modelId: 'm1', observeAfterTokens: 12_000 } }, null),
      12_000,
    );
  });

  it('null only when no observer model is resolvable at all', () => {
    assert.equal(chatObserveAfterTokens({}, null), null);
    assert.equal(chatObserveAfterTokens(null, undefined), null);
  });
});

describe('CONCIERGE-PARAMS — params-sized budget in the meter', () => {
  it('shows the params window instead of the provider default and clamps used under it', async () => {
    const qwenAgent = { ...agent, modelId: 'qwen/qwen3.6-35b-a3b', providerId: 'p-qwen', runtimeConfig: {} };
    const qwenProvider = { defaultModelSettings: { maxContextTokens: 132_000 } };
    const budget = resolveAgentContextBudget(
      qwenAgent as never,
      qwenProvider as never,
      'chat',
      { maxContextTokens: 65_536, maxOutputTokens: 2_048 },
    );
    assert.equal(budget.contextTokens, 65_536);
    assert.equal(budget.limiterLimit, 55_488);

    const huge = [{ role: 'user', content: 'x'.repeat(4_000_000) }];
    const meter = await threadContextMeter(qwenAgent, {}, huge, {
      resolveBudget: async () => budget,
      observeAfterTokens: async () => null,
    });
    assert.equal(meter.limitTokens, 65_536, 'the limit shown is the params window, not the provider default');
    assert.ok(meter.usedTokens <= meter.limitTokens, 'used stays clamped to the budget (single number)');
    assert.equal(meter.level, 'over');
  });

  it('unset params keep the provider default budget', () => {
    const budget = resolveAgentContextBudget(
      { ...agent, runtimeConfig: {} } as never,
      { defaultModelSettings: { maxContextTokens: 132_000 } } as never,
      'chat',
    );
    assert.equal(budget.contextTokens, 132_000);
  });
});

/**
 * CONCIERGE-PARAMS S2 (gate #195): the meter's DB glue (defaultContextMeterDeps) applied the
 * concierge pair and its params without a test — the pair or its params being dropped there
 * survived mutants. These drive the REAL resolveBudget/observeAfterTokens branches through the
 * injectable ContextMeterRunContextDeps boundary (no Postgres).
 */
type ProviderRow = Parameters<ContextMeterRunContextDeps['resolveProviderRow']> extends never ? never
  : { id: string; name: string; type: string; baseURL: string; apiKey: string; headers: unknown; apiMode: string; isDefault: boolean; defaultModelSettings: unknown };

const providerRow = (id: string, maxContextTokens: number): ProviderRow => ({
  id,
  name: id,
  type: 'openai',
  baseURL: 'http://127.0.0.1:1234/v1',
  apiKey: 'test',
  headers: {},
  apiMode: 'chat',
  isDefault: false,
  defaultModelSettings: { maxContextTokens },
});

function glueDeps(overrides: Partial<ContextMeterRunContextDeps> & { requested?: string[] }) {
  const requested = overrides.requested ?? [];
  const base = overrides as Partial<ContextMeterRunContextDeps>;
  return {
    requested,
    deps: createContextMeterDeps({
      loadCompanySettings: async () => ({}),
      isProviderAvailable: async () => true,
      resolveProviderRow: async (_companyId, providerId) => {
        requested.push(providerId ?? 'none');
        return { row: providerRow(providerId ?? 'none', 132_000) };
      },
      ...base,
    }),
  };
}

describe('createContextMeterDeps — concierge pair DB glue (CONCIERGE-PARAMS S2)', () => {
  const noOverrideAgent = { ...agent, runtimeConfig: {} };

  it('free chat applies the concierge pair AND its params (mutants: drop pair / drop params)', async () => {
    const { requested, deps } = glueDeps({
      loadCompanySettings: async () => ({
        conciergeModel: {
          providerId: 'p-conc',
          modelId: 'qwen/qwen3.6-35b-a3b',
          params: { maxContextTokens: 65_536, maxOutputTokens: 2_048 },
        },
      }),
    });
    const budget = await deps.resolveBudget(noOverrideAgent, null);
    assert.deepEqual(requested, ['p-conc'], 'the effective model is the PAIR provider, not the agent provider');
    assert.equal(budget.contextTokens, 65_536, 'pair params beat the provider default (drop-params mutant → 132000)');
    assert.equal(budget.limiterLimit, 55_488, 'hard context guard sized from the pair params');
  });

  it('a pair whose provider is off falls back to the agent model (PRV-1)', async () => {
    const { requested, deps } = glueDeps({
      isProviderAvailable: async () => false,
      loadCompanySettings: async () => ({
        conciergeModel: { providerId: 'p-conc', modelId: 'm-conc', params: { maxContextTokens: 65_536 } },
      }),
    });
    const budget = await deps.resolveBudget(noOverrideAgent, null);
    assert.deepEqual(requested, ['p-agent'], 'the off pair is ignored: the agent provider resolves');
    assert.equal(budget.contextTokens, 132_000, 'provider default, params never applied');
  });

  it('a pair without params keeps the provider default window', async () => {
    const { deps } = glueDeps({
      loadCompanySettings: async () => ({ conciergeModel: { providerId: 'p-conc', modelId: 'm-conc' } }),
    });
    const budget = await deps.resolveBudget(noOverrideAgent, null);
    assert.equal(budget.contextTokens, 132_000);
  });
});

/**
 * CONCIERGE-OM S6 (gate #194): defaultContextMeterDeps.observeAfterTokens bypassed the tested
 * chatObserveAfterTokens helper — regressing the DB glue to the heartbeat resolver returned null
 * and the meter ignored the compaction point chat actually runs. These pin the glue end-to-end.
 */
describe('createContextMeterDeps — observeAfterTokens DB glue (CONCIERGE-OM S6)', () => {
  const omAgent = { ...agent, runtimeConfig: { observationalMemory: { mode: 'off' } } };

  it('resolves the chat compaction point through the DB glue even when heartbeats are off', async () => {
    const { deps } = glueDeps({
      loadCompanySettings: async () => ({
        observationalMemory: { enabled: false, providerId: 'p1', modelId: 'om-model', observeAfterTokens: 12_000 },
      }),
    });
    assert.equal(await deps.observeAfterTokens(omAgent), 12_000, 'chat resolver honours the disabled-company custom threshold');
  });

  it('concierge-only company still has an OM compaction point in chat', async () => {
    const { deps } = glueDeps({
      loadCompanySettings: async () => ({ conciergeModel: { providerId: 'p-c', modelId: 'm-c' } }),
    });
    assert.equal(await deps.observeAfterTokens(agent), 30_000, 'default chat threshold from the concierge fallback');
  });

  it('null when no observer model is resolvable (also for a missing company row)', async () => {
    const { deps } = glueDeps({ loadCompanySettings: async () => ({}) });
    assert.equal(await deps.observeAfterTokens(agent), null);
    const missing = createContextMeterDeps({ loadCompanySettings: async () => undefined });
    assert.equal(await missing.observeAfterTokens(agent), null);
  });
});
