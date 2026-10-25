/**
 * CTX-1: the meter's limit comes from the real chat budget (resolveAgentContextBudget with the
 * provider defaults and agent overrides); the thread's model choice is passed to the budget.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentContextBudget } from '../../../../packages/mastra/src/model-settings';
import { toolSchemaReserveForKind } from '@tourbillon/shared/context-budget';
import { threadContextMeter, type ContextMeterAgent, type ContextMeterDeps } from './context-meter-service';
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
